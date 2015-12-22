var shortid = require('shortid');
var urljoin = require('url-join');

// http://blog.celingest.com/en/2013/12/12/cloudfront-configuring-custom-error-pages/

module.exports = function(settings, certificate) {
  return {
    DistributionConfig: {
      CallerReference: shortid.generate(),
      DefaultRootObject: 'index.html',
      Origins: {
        Quantity: 2,
        Items: [
          mainHostOrigin(certificate, settings),
          customErrorsOrigin(certificate, settings)
        ]
      },
      DefaultCacheBehavior: defaultCacheBehavior(certificate, settings),
      CacheBehaviors: {
        Quantity: 2,
        Items: [
          cdnPassthroughBehavior(certificate, settings),
          customErrorsBehavior(certificate, settings)
        ]
      },
      CustomErrorResponses: customErrorResponses(settings),
      Comment: certificate.commonName,
      Logging: {
        Enabled: true,
        IncludeCookies: false,
        Bucket: settings.cloudFrontLogBucket,
        Prefix: certificate.commonName + '/'
      },
      PriceClass: 'PriceClass_All',
      Enabled: true,
      ViewerCertificate: {
        IAMCertificateId: certificate.certificateId,
        SSLSupportMethod: 'sni-only',
        MinimumProtocolVersion: 'TLSv1'
      }
    }
  };
};

function mainHostOrigin(certificate, settings) {
  return {
    Id: certificate.commonName,
    DomainName: settings.cloudFrontOriginDomain,
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort: 443,
      // Ideally this would be set to 'match-viewer' so that https requests are forwarded as
      // https to the origin. However right now CloudFront passes the Host header of the viewer
      // request rather than X-Forwarded-Host. This causes an SSL mismatch with the certificate
      // on the ELB. Posted following question on AWS support boards:
      // https://forums.aws.amazon.com/thread.jspa?messageID=682411&#682411
      //
      // This thread also discusses the SSL mismatch issue. However the poster states
      // that he whitelisted Host header and it worked which was not the case for me.
      // Guessing that the distribution just hadn't finished updating.
      // https://forums.aws.amazon.com/thread.jspa?threadID=157194
      OriginProtocolPolicy: 'http-only' // forces CF to forward using the protocol of the incoming request
    }
  };
}

function customErrorsOrigin(certificate, settings) {
  return {
    Id: certificate.commonName + '-custom-errors',
    DomainName: settings.cloudFrontCustomErrorsDomain,
    S3OriginConfig: {
      OriginAccessIdentity: ''
    }
  };
}

function defaultCacheBehavior(certificate, settings) {
  return {
    TargetOriginId: certificate.name,
    ForwardedValues: {
      QueryString: true,
      Cookies: {
        Forward: 'none'
      },
      // Forward all headers to the origin
      Headers: {
        Quantity: 4,
        // For now need to pass the CloudFront-Forwarded-Proto because currently
        // forced to forward everything as HTTP to the origin. Without this header
        // the 4front Beanstalk server would not be able to determine the original
        // request is SSL.
        Items: ['Host', 'Authorization', 'CloudFront-Forwarded-Proto', 'Accept']
      }
    },
    TrustedSigners: {
      Enabled: false,
      Quantity: 0
    },
    ViewerProtocolPolicy: 'allow-all',
    MinTTL: 0,
    AllowedMethods: {
      Quantity: 7,
      Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
      // These are the actual methods that can be cached on the CDN
      CachedMethods: {
        Quantity: 3,
        Items: ['GET', 'HEAD', 'OPTIONS']
      }
    },
    SmoothStreaming: false
  };
}

// Exception behavior that does not do any caching,
// but forwards along all headers and cookies. The default
// cache behavior has a whitelist of headers and cookies.
function cdnPassthroughBehavior(certificate, settings) {
  return {
    TargetOriginId: certificate.commonName,
    PathPattern: settings.cloudFrontNoCachePathPattern,
    ForwardedValues: {
      QueryString: true,
      Cookies: {
        Forward: 'all'
      },
      // Forward all headers to the origin
      Headers: {
        Quantity: 1,
        Items: ['*']
      }
    },
    TrustedSigners: {
      Enabled: false,
      Quantity: 0
    },
    ViewerProtocolPolicy: 'allow-all',
    MinTTL: 0,
    AllowedMethods: {
      Quantity: 7,
      Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']
    },
    SmoothStreaming: false
  };
}

function customErrorsBehavior(certificate, settings) {
  return {
    TargetOriginId: certificate.commonName + '-custom-errors',
    PathPattern: urljoin(settings.cloudFrontCustomErrorsPath, '*'),
    ForwardedValues: {
      QueryString: false,
      Cookies: {
        Forward: 'none'
      },
      Headers: {
        Quantity: 0
      }
    },
    TrustedSigners: {
      Enabled: false,
      Quantity: 0
    },
    ViewerProtocolPolicy: 'allow-all',
    MinTTL: 0,
    AllowedMethods: {
      Quantity: 7,
      Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']
    },
    SmoothStreaming: false
  };
}

function customErrorResponses(settings) {
  var serverErrors = [502, 503, 504].map(function(code) {
    return {
      ErrorCode: code,
      ResponsePagePath: urljoin(settings.cloudFrontCustomErrorsPath, code + '.html'),
      ResponseCode: code.toString(),
      ErrorCachingMinTTL: 0
    };
  });

  // A 403 error is returned when the custom CNAME is not yet resolving.
  serverErrors.push({
    ErrorCode: 403,
    ResponsePagePath: urljoin(settings.cloudFrontCustomErrorsPath, '403.html'),
    ResponseCode: '403',
    ErrorCachingMinTTL: 0
  });

  return {
    Quantity: serverErrors.length,
    Items: serverErrors
  };
}
