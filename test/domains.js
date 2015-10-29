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

  it('throws error if domain already registered', function(done) {
    this.cloudFrontStub.updateDistribution = function(params, callback) {
      callback(Error.create('No duplicates allowed', {
        code: 'InvalidArgument'
      }));
    };

    this.domainManager.register('two.domain.com', null, function(err) {
      assert.equal(err.code, 'CNAMEAlreadyExists');
      done();
    });
  });

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

  describe('uploadCertificate', function() {
    beforeEach(function() {
      self = this;

      this.commonName = 'www.jsngin.com';
      var certificateBody = fs.readFileSync(path.join(__dirname, './fixtures/cert.key')).toString();
      // Only the certificateBody has to be valid for the unit test.
      this.certificate = {
        orgId: this.orgId,
        certificateBody: certificateBody,
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAKCAQEAyFI8vGS8rGbI\n-----END RSA PRIVATE KEY-----',
        certificateChain: '-----BEGIN CERTIFICATE-----\nMIIF2TCCA8GgAwIBAgIHFxU9nqs\n-----END CERTIFICATE-----'
      };
    });

    it('upload valid certificate', function(done) {
      this.createdDistribution = {
        Id: shortid.generate(),
        Status: 'InProgress',
        DomainName: shortid.generate() + '.cloudfront.net'
      };

      this.domainManager.uploadCertificate(this.certificate, function(err, uploadedCert) {
        if (err) return done(err);

        assert.isTrue(self.iamStub.uploadServerCertificate.calledWith({
          CertificateBody: self.certificate.certificateBody,
          ServerCertificateName: self.commonName,
          Path: '/cloudfront/' + self.domainManagerSettings.serverCertificatePathPrefix + self.commonName + '/',
          PrivateKey: self.certificate.privateKey,
          CertificateChain: self.certificate.certificateChain
        }));

        assert.isTrue(self.cloudFrontStub.createDistribution.called);
        var distributionConfig = self.cloudFrontStub.createDistribution.getCall(0).args[0].DistributionConfig;

        assert.equal(1, distributionConfig.Origins.Quantity);
        assert.equal(1, distributionConfig.Origins.Items.length);
        assert.equal(self.domainManagerSettings.cloudFrontOriginDomain, distributionConfig.Origins.Items[0].DomainName);
        assert.equal(self.commonName, uploadedCert.commonName);
        assert.equal(self.commonName, uploadedCert.name);

        assert.equal(uploadedCert.expires.getTime(), new Date(self.certificateMetadata.Expiration).getTime());
        assert.equal(uploadedCert.cname, self.createdDistribution.DomainName);

        done();
      });
    });

    it('upload wildcard cert', function(done) {
      this.commonName = '*.testdomain.com';
      this.certificate.certificateBody = fs.readFileSync(path.join(__dirname, './fixtures/wildcard.key')).toString();

      this.createdDistribution = {
        Id: shortid.generate(),
        Status: 'InProgress',
        DomainName: shortid.generate() + '.cloudfront.net'
      };

      this.domainManager.uploadCertificate(this.certificate, function(err, uploadedCert) {
        if (err) return done(err);

        var uploadCertArg = self.iamStub.uploadServerCertificate.getCall(0).args[0];
        assert.equal(uploadCertArg.CertificateBody, self.certificate.certificateBody);
        assert.equal(uploadCertArg.ServerCertificateName, '@.testdomain.com');
        assert.equal(uploadCertArg.Path, '/cloudfront/' + self.domainManagerSettings.serverCertificatePathPrefix + self.commonName + '/');
        assert.isTrue(self.cloudFrontStub.createDistribution.called);
        assert.equal(uploadedCert.commonName, self.commonName);

        // The cert name should have replaced the '*' with an '@'
        assert.equal(uploadedCert.name, '@.testdomain.com');
        assert.equal(uploadedCert.cname, self.createdDistribution.DomainName);

        done();
      });
    });

    it('un-parseable x509 cert body', function(done) {
      this.certificate.certificateBody = 'invalid_cert_body';
      this.domainManager.uploadCertificate(this.certificate, function(err) {
        assert.equal(err.code, 'malformedCertificate');
        assert.isTrue(err.badRequest);
        done();
      });
    });

    it('invalid certificate chain', function(done) {
      this.iamStub.uploadServerCertificate = function(params, callback) {
        callback(Error.create('Unable to validate certificate chain', {
          code: 'MalformedCertificate'
        }));
      };

      this.domainManager.uploadCertificate(this.certificate, function(err) {
        assert.equal(err.code, 'malformedCertificate');
        assert.isTrue(err.badRequest);
        done();
      });
    });

    it('certificate already exists', function(done) {
      this.iamStub.uploadServerCertificate = function(params, callback) {
        callback(Error.create('Server Certificate', {
          code: 'EntityAlreadyExists',
        }));
      };

      this.domainManager.uploadCertificate(this.certificate, function(err) {
        assert.equal(err.code, 'certificateExists');
        assert.equal(err.certDomain, 'www.jsngin.com');
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

      self.domainManager.transferDomain(domainName, currentDistributionId, targetDistributionId, function(err, newDistributionId) {
        if (err) return done(err);

        assert.equal(newDistributionId, targetDistributionId);
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

  it('delete certificate', function(done) {
    this.iamStub.deleteServerCertificate = sinon.spy(function(params, callback) {
      callback();
    });

    var certName = 'www.domain.com';
    this.domainManager.deleteCertificate(certName, function(err) {
      if (err) return done(err);

      assert.isTrue(self.iamStub.deleteServerCertificate.calledWith({ServerCertificateName: certName}));
      done();
    });
  });

  it('get certificate status', function(done) {
    var certificate = {
      zone: shortid.generate()
    };
    var distroStatus = 'InProgress';

    this.cloudFrontStub.getDistribution = sinon.spy(function(distributionId, callback) {
      callback(null, {
        Distribution: {Status: distroStatus}
      });
    });

    this.domainManager.getCertificateStatus(certificate, function(err, status) {
      if (err) return done(err);
      assert.isTrue(self.cloudFrontStub.getDistribution.calledWith({Id: certificate.zone}));
      assert.equal(status, distroStatus);
      done();
    });
  });
});
