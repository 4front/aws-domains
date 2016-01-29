var shortid = require('shortid');
var urljoin = require('url-join');

// http://blog.celingest.com/en/2013/12/12/cloudfront-configuring-custom-error-pages/

module.exports = function(settings, topLevelDomain, certificateArn) {
  var distributionName = topLevelDomain;
  var distributionConfig = {
    DistributionConfig: {
      CallerReference: shortid.generate(),
      DefaultRootObject: '',
      Origins: {
        Quantity: 2,
        Items: [
          mainHostOrigin(settings, distributionName),
          customErrorsOrigin(settings, distributionName)
        ]
      },
      // Create two aliases, one for the wildcard and another for the apex domain.
      // Technically the client cannot point their apex domain at Cloudfront because
      // an A record requires an IP address. But adding it anyway in case AWS figures
      // this out. Also if the DNS provider is Route53 an alias can be set to point
      // at the distribution, tho not sure if this works across AWS accounts.
      Aliases: {
        Quantity: 2,
        Items: ['*.' + topLevelDomain, topLevelDomain]
      },
      DefaultCacheBehavior: defaultCacheBehavior(settings, distributionName),
      CacheBehaviors: {
        Quantity: 2,
        Items: [
          cdnPassthroughBehavior(settings, distributionName),
          customErrorsBehavior(settings, distributionName)
        ]
      },
      CustomErrorResponses: customErrorResponses(settings),
      Comment: distributionName,
      Logging: {
        Enabled: true,
        IncludeCookies: false,
        Bucket: settings.cloudFrontLogBucket,
        Prefix: distributionName + '/'
      },
      PriceClass: 'PriceClass_All',
      Enabled: true
    }
  };

  if (certificateArn) {
    distributionConfig.DistributionConfig.ViewerCertificate = {
      IAMCertificateId: certificateArn,
      CertificateSource: 'acm',
      SSLSupportMethod: 'sni-only',
      MinimumProtocolVersion: 'TLSv1'
    };
  }

  return distributionConfig;
};

function mainHostOrigin(settings, distributionName) {
  return {
    Id: distributionName,
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

function customErrorsOrigin(settings, distributionName) {
  return {
    Id: distributionName + '-custom-errors',
    DomainName: settings.cloudFrontCustomErrorsDomain,
    S3OriginConfig: {
      OriginAccessIdentity: ''
    }
  };
}

function defaultCacheBehavior(settings, distributionName) {
  return {
    TargetOriginId: distributionName,
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
function cdnPassthroughBehavior(settings, distributionName) {
  return {
    TargetOriginId: distributionName,
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

function customErrorsBehavior(settings, distributionName) {
  return {
    TargetOriginId: distributionName + '-custom-errors',
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

  return {
    Quantity: serverErrors.length,
    Items: serverErrors
  };
}
