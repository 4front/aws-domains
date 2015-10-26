var assert = require('assert');
var _ = require('lodash');
var shortid = require('shortid');
var sinon = require('sinon');
var fs = require('fs');
var path = require('path');
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
      createDistribution: sinon.spy(function(params, callback) {
        callback(null, {Distribution: self.createdDistribution});
      }),
      updateDistribution: sinon.spy(function(params, callback) {
        callback(null, {
          Distribution: _.pick(params, 'Id', 'DistributionConfig')
        });
      })
    };

    this.certificateMetadata = {
      ServerCertificateId: shortid.generate(),
      Expiration: new Date(Date.now() + 100000000).toISOString(),
      UploadDate: new Date().toISOString()
    };

    this.iamStub = {
      uploadServerCertificate: sinon.spy(function(params, callback) {
        callback(null, {ServerCertificateMetadata: self.certificateMetadata});
      })
    };

    sinon.stub(AWS, 'IAM', function() {
      return self.iamStub;
    });

    sinon.stub(AWS, 'CloudFront', function() {
      return self.cloudFrontStub;
    });

    this.domainManagerSettings = {
      cloudFrontDistributions: _.map(self.distributions, function(distro) {
        return distro.Distribution.Id;
      }),
      maxAliasesPerDistribution: 3,
      cloudFrontOriginDomain: 'origin.com',
      cloudFrontLogBucket: 'log-bucket',
      serverCertificatePathPrefix: 'cert-prefix/',
      cookiePrefix: '4front_'
    };

    this.domainManager = new DomainManager(this.domainManagerSettings);
  });

  afterEach(function() {
    sinon.restore(AWS, 'CloudFront');
    sinon.restore(AWS, 'IAM');
  });

  it('creates CNAME alias in first available distribution', function(done) {
    this.domainManager.register('test.mydomain.com', null, function(err, distributionId) {
      if (err) return done(err);

      assert.equal(1, self.cloudFrontStub.getDistribution.callCount);
      assert.ok(self.cloudFrontStub.getDistribution.calledWith(sinon.match({
        Id: self.distributions[0].Distribution.Id
      })));

      assert.ok(self.cloudFrontStub.updateDistribution.called);

      var updatedDistribution = self.cloudFrontStub.updateDistribution.getCall(0).args[0];
      assert.deepEqual(updatedDistribution.DistributionConfig.Aliases, {
        Items: ['test.mydomain.com'],
        Quantity: 1
      });

      assert.equal(updatedDistribution.Id, self.distributions[0].Distribution.Id);

      assert.equal(distributionId, self.distributions[0].Distribution.Id);
      done();
    });
  });

  it('creates CNAME alias in 2nd distribution if first is full', function(done) {
    var firstDistro = this.distributions[0].Distribution.DistributionConfig;
    _.times(3, function(i) {
      firstDistro.Aliases.Items.push(i + '.domain.com');
    });

    firstDistro.Aliases.Quantity = 3;

    this.domainManager.register('test.mydomain.com', null, function(err, distributionId) {
      if (err) return done(err);

      var distroIds = _.map(self.distributions, function(distro) {
        return distro.Distribution.Id;
      });

      assert.equal(2, self.cloudFrontStub.getDistribution.callCount);
      assert.ok(self.cloudFrontStub.getDistribution.calledWith({Id: distroIds[0]}));
      assert.ok(self.cloudFrontStub.getDistribution.calledWith({Id: distroIds[1]}));
      assert.equal(self.cloudFrontStub.updateDistribution.getCall(0).args[0].Id, distroIds[1]);
      assert.equal(distributionId, distroIds[1]);

      done();
    });
  });

  // it('throws error if domain already registered', function(done) {
  //   this.distributions[0].Distribution.DistributionConfig.Aliases = {
  //     Items: ['one.domain.com', 'two.domain.com', 'three.domain.com'],
  //     Quantity: 3
  //   };
  //
  //   this.domainManager.register('two.domain.com', function(err) {
  //     assert.equal(err.code, "domainAlredyRegistered");
  //     done();
  //   });
  // });

  it('unregisters domain', function(done) {
    this.distributions[1].Distribution.DistributionConfig.Aliases = {
      Items: ['one.domain.com', 'two.domain.com', 'three.domain.com'],
      Quantity: 3
    };

    var distributionId = this.distributions[1].Distribution.Id;
    this.domainManager.unregister('two.domain.com', distributionId, function(err) {
      assert.ok(self.cloudFrontStub.getDistribution.calledWith({Id: distributionId}));

      assert.equal(self.cloudFrontStub.updateDistribution.callCount, 1);
      assert.equal(self.cloudFrontStub.updateDistribution.getCall(0).args[0].Id, distributionId);
      assert.deepEqual(self.cloudFrontStub.updateDistribution.getCall(0).args[0].DistributionConfig.Aliases, {
        Items: ['one.domain.com', 'three.domain.com'],
        Quantity: 2
      });

      done();
    });
  });

  describe('uploadServerCertificate', function() {
    beforeEach(function() {
      self = this;
    });

    it('upload valid certificate', function(done) {
      var commonName = 'www.jsngin.com';
      var certificateBody = fs.readFileSync(path.join(__dirname, './mock-data/cert.key')).toString();
      // Only the certificateBody has to be valid for the unit test.
      var certificate = {
        orgId: this.orgId,
        certificateBody: certificateBody,
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAKCAQEAyFI8vGS8rGbI\n-----END RSA PRIVATE KEY-----',
        certificateChain: '-----BEGIN CERTIFICATE-----\nMIIF2TCCA8GgAwIBAgIHFxU9nqs\n-----END CERTIFICATE-----'
      };

      this.createdDistribution = {
        Id: shortid.generate(),
        Status: 'InProgress'
      };

      this.domainManager.uploadServerCertificate(certificate, function(err, uploadedCert) {
        if (err) return done(err);

        assert.isTrue(self.iamStub.uploadServerCertificate.calledWith({
          CertificateBody: certificate.certificateBody,
          ServerCertificateName: commonName,
          Path: '/cloudfront/' + self.domainManagerSettings.serverCertificatePathPrefix + commonName + '/',
          PrivateKey: certificate.privateKey,
          CertificateChain: certificate.certificateChain
        }));

        assert.isTrue(self.cloudFrontStub.createDistribution.called);
        var distributionConfig = self.cloudFrontStub.createDistribution.getCall(0).args[0].DistributionConfig;

        assert.equal(1, distributionConfig.Origins.Quantity);
        assert.equal(1, distributionConfig.Origins.Items.length);
        assert.equal(self.domainManagerSettings.cloudFrontOriginDomain, distributionConfig.Origins.Items[0].DomainName);

        assert.equal(uploadedCert.expires.getTime(), new Date(self.certificateMetadata.Expiration).getTime());

        done();
      });
    });
  });

  describe('transfer domain', function() {
    it('from shared distro to dedicated SSL distro', function(done) {
      var domainName = 'test.mydomain.com';
      var currentDistributionId = self.distributions[0].Distribution.Id;
      var targetDistributionId = self.distributions[1].Distribution.Id;

      this.distributions[0].Distribution.DistributionConfig.Aliases = {
        Quantity: 1,
        Items: [domainName]
      };

      self.domainManager.transferDomain(domainName, currentDistributionId, targetDistributionId, function(err) {
        if (err) return done(err);

        assert.equal(self.cloudFrontStub.getDistribution.callCount, 2);
        assert.equal(self.cloudFrontStub.updateDistribution.callCount, 2);

        assert.isTrue(self.cloudFrontStub.getDistribution.calledWith({Id: currentDistributionId}));
        var currentUpdateConfig = self.cloudFrontStub.updateDistribution.getCall(0).args[0].DistributionConfig;
        assert.equal(currentUpdateConfig.Aliases.Items.indexOf(domainName), -1);

        assert.isTrue(self.cloudFrontStub.getDistribution.calledWith({Id: targetDistributionId}));
        var targetUpdateConfig = self.cloudFrontStub.updateDistribution.getCall(1).args[0].DistributionConfig;
        assert.notEqual(targetUpdateConfig.Aliases.Items.indexOf(domainName), -1);
        done();
      });
    });
  });
});
