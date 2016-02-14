var assert = require('assert');
var _ = require('lodash');
var shortid = require('shortid');
var sinon = require('sinon');
var sha1 = require('sha1');
var AWS = require('aws-sdk');

require('dash-assert');
var DomainManager = require('..');

describe('AwsDomainManager', function() {
  var self;

  beforeEach(function() {
    self = this;

    this.orgId = shortid.generate();

    // Create 3 distributions
    this.distributions = _.times(3, function() {
      return {
        ETag: shortid.generate(),
        Distribution: {
          Id: shortid.generate(),
          DistributionConfig: {
            Aliases: {
              Items: [],
              Quantity: 0
            }
          }
        }
      };
    });

    this.cloudFrontStub = {
      getDistribution: sinon.spy(function(params, callback) {
        var distribution = _.find(self.distributions, function(distro) {
          return distro.Distribution.Id === params.Id;
        });

        callback(null, distribution);
      }),
      getDistributionConfig: sinon.spy(function(params, callback) {
        callback(null, {DistributionConfig: {}});
      }),
      deleteDistribution: sinon.spy(function(params, callback) {
        callback();
      }),
      updateDistribution: sinon.spy(function(params, callback) {
        callback(null, {
          Distribution: _.pick(params, 'Id', 'DistributionConfig')
        });
      })
    };

    this.acmStub = {
      deleteCertificate: sinon.spy(function(params, callback) {
        callback();
      }),
      resendValidationEmail: sinon.spy(function(params, callback) {
        callback();
      })
    };

    sinon.stub(AWS, 'IAM', function() {
      return self.iamStub;
    });

    sinon.stub(AWS, 'CloudFront', function() {
      return self.cloudFrontStub;
    });

    sinon.stub(AWS, 'ACM', function() {
      return self.acmStub;
    });

    this.domainManagerSettings = {
      cloudFrontDistributions: _.map(self.distributions, function(distro) {
        return distro.Distribution.Id;
      }),
      maxAliasesPerDistribution: 3,
      cloudFrontOriginDomain: 'origin.com',
      cloudFrontLogBucket: 'log-bucket',
      cloudFrontCustomErrorsDomain: 'bucket-name.s3.amazonaws.com', //eslint-disable-line
      cloudFrontCustomErrorsPath: '/__cloudfront-errors', //eslint-disable-line
      cloudFrontNoCachePathPattern: '/__nocdn', //eslint-disable-line
      serverCertificatePathPrefix: 'cert-prefix/', //eslint-disable-line
      cookiePrefix: '4front_'
    };

    this.domainManager = new DomainManager(this.domainManagerSettings);
  });

  afterEach(function() {
    sinon.restore(AWS, 'CloudFront');
    sinon.restore(AWS, 'IAM');
    sinon.restore(AWS, 'ACM');
  });

  it('requestWildcardCertificate', function(done) {
    var domainName = shortid.generate() + '.com';
    var certificateId = shortid.generate();

    this.acmStub.requestCertificate = sinon.spy(function(params, callback) {
      callback(null, {CertificateArn: certificateId});
    });

    this.domainManager.requestWildcardCertificate(domainName, function(err, data) {
      if (err) return done(err);

      assert.equal(data, certificateId);

      assert.isTrue(self.acmStub.requestCertificate.calledWith({
        DomainName: '*.' + domainName,
        DomainValidationOptions: [
          {
            DomainName: '*.' + domainName,
            ValidationDomain: domainName
          }
        ],
        IdempotencyToken: sha1(domainName).substr(0, 31),
        SubjectAlternativeNames: [domainName]
      }));
      done();
    });
  });

  it('createCdnDistribution', function(done) {
    var topLevelDomain = 'jsngin.com';
    var distributionId = shortid.generate();
    var certificateId = shortid.generate();
    var distributionDomainName = shortid.generate() + '.cloudfront.net';

    this.cloudFrontStub.createDistribution = sinon.spy(function(params, callback) {
      callback(null, {Distribution: {
        Id: distributionId,
        DomainName: distributionDomainName,
        Status: 'InProgress'
      }});
    });

    this.domainManager.createCdnDistribution(topLevelDomain, certificateId, function(err, distribution) {
      if (err) return done(err);

      assert.isTrue(self.cloudFrontStub.createDistribution.called);
      var distributionConfig = self.cloudFrontStub.createDistribution.getCall(0).args[0].DistributionConfig;

      assert.equal(distributionConfig.DefaultCacheBehavior.TargetOriginId, topLevelDomain);

      assert.equal(2, distributionConfig.Origins.Quantity);
      assert.equal(2, distributionConfig.Origins.Items.length);

      assert.equal(self.domainManagerSettings.cloudFrontOriginDomain, distributionConfig.Origins.Items[0].DomainName);
      assert.equal(distributionConfig.Origins.Items[1].DomainName, self.domainManagerSettings.cloudFrontCustomErrorsDomain);

      // Assertions about the cache behaviors
      assert.equal(2, distributionConfig.CacheBehaviors.Quantity);
      assert.equal(2, distributionConfig.CacheBehaviors.Items.length);

      assert.equal(distributionConfig.CacheBehaviors.Items[0].PathPattern, self.domainManagerSettings.cloudFrontNoCachePathPattern);

      var customErrorsBehavior = distributionConfig.CacheBehaviors.Items[1];
      assert.equal(customErrorsBehavior.PathPattern, '/__cloudfront-errors/*');
      assert.equal(customErrorsBehavior.TargetOriginId, topLevelDomain + '-custom-errors');

      var customErrorResponses = distributionConfig.CustomErrorResponses;
      assert.equal(3, customErrorResponses.Quantity);
      assert.equal(3, customErrorResponses.Items.length);

      assert.isTrue(_.any(customErrorResponses.Items, {ErrorCode: 502, ResponsePagePath: '/__cloudfront-errors/502.html'}));
      assert.isTrue(_.any(customErrorResponses.Items, {ErrorCode: 503}));
      assert.isTrue(_.any(customErrorResponses.Items, {ErrorCode: 504}));

      assert.deepEqual(distribution, {
        distributionId: distributionId,
        status: 'InProgress',
        domainName: distributionDomainName
      });

      done();
    });
  });

  it('delete certificate', function(done) {
    var certificateId = shortid.generate();

    this.domainManager.deleteCertificate(certificateId, function(err) {
      if (err) return done(err);

      assert.isTrue(self.acmStub.deleteCertificate.calledWith({CertificateArn: certificateId}));
      done();
    });
  });

  it('delete CDN distribution', function(done) {
    var distributionId = shortid.generate();

    this.domainManager.deleteCdnDistribution(distributionId, function(err) {
      if (err) return done(err);

      assert.isTrue(self.cloudFrontStub.updateDistribution.calledWith(sinon.match({
        Id: distributionId,
        DistributionConfig: sinon.match({
          Enabled: false,
          ViewerCertificate: {},
          Aliases: {
            Quantity: 0
          }
        })
      })));
      done();
    });
  });

  it('get certificate status', function(done) {
    var certificateId = shortid.generate();

    this.acmStub.describeCertificate = sinon.spy(function(params, callback) {
      callback(null, {
        Certificate: {
          CertificateArn: params.CertificateArn,
          Status: 'PENDING_VALIDATION'
        }
      });
    });

    this.domainManager.getCertificateStatus(certificateId, function(err, status) {
      if (err) return done(err);
      assert.isTrue(self.acmStub.describeCertificate.calledWith({CertificateArn: certificateId}));
      assert.equal(status, 'PENDING_VALIDATION');
      done();
    });
  });

  it('get CDN distribution status', function(done) {
    var distributionId = shortid.generate();
    var distroStatus = 'InProgress';

    this.cloudFrontStub.getDistribution = sinon.spy(function(id, callback) {
      callback(null, {
        Distribution: {Status: distroStatus}
      });
    });

    this.domainManager.getCdnDistributionStatus(distributionId, function(err, status) {
      if (err) return done(err);
      assert.isTrue(self.cloudFrontStub.getDistribution.calledWith({Id: distributionId}));
      assert.equal(status, distroStatus);
      done();
    });
  });

  it('resend validation email', function(done) {
    this.acmStub.resendValidationEmail = sinon.spy(function(params, callback) {
      callback();
    });

    var domainName = shortid.generate() + '.net';
    var certificateId = shortid.generate();
    this.domainManager.resendValidationEmail(domainName, certificateId, function(err) {
      if (err) return done(err);
      assert.isTrue(self.acmStub.resendValidationEmail.calledWith({
        Domain: domainName,
        CertificateArn: certificateId,
        ValidationDomain: domainName
      }));
      done();
    });
  });
});
