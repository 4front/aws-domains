var AWS = require('aws-sdk');
var _ = require('lodash');
var async = require('async');
var sha1 = require('sha1');
var distributionConfig = require('./lib/distribution-config');
var debug = require('debug')('4front:aws-domains');

require('simple-errors');

module.exports = DomainManager;

function DomainManager(settings) {
  this._cloudFront = new AWS.CloudFront();
  // this._iam = new AWS.IAM();
  this._certManager = new AWS.ACM(settings.certificateManagerRegion ?
    {region: settings.certificateManagerRegion} : null);
  this._settings = settings;
}

DomainManager.prototype.createCdnDistribution = function(domainName, certificateArn, callback) {
  // Name the distribution after the topLevelDomain, i.e. "customdomain.com"
  var config = distributionConfig(this._settings, domainName, certificateArn);

  this._cloudFront.createDistribution(config, function(err, data) {
    if (err) return callback(err);

    callback(null, {
      distributionId: data.Distribution.Id,
      status: data.Distribution.Status,
      domainName: data.Distribution.DomainName
    });
  });
};

DomainManager.prototype.requestWildcardCertificate = function(domainName, callback) {
  var params = {
    DomainName: '*.' + domainName,
    DomainValidationOptions: [
      {
        DomainName: '*.' + domainName,
        ValidationDomain: domainName
      }
    ],
    // just use a hash of the domainName as the idempotency token
    IdempotencyToken: sha1(domainName).substr(0, 31),
    // request that the apex domain be listed as a SAN
    SubjectAlternativeNames: [domainName]
  };

  this._certManager.requestCertificate(params, function(err, data) {
    if (err) return callback(err);
    callback(null, data.CertificateArn);
  });
};

// Get the status of the CloudFront CDN distribution
DomainManager.prototype.getCdnDistributionStatus = function(distributionId, callback) {
  this._cloudFront.getDistribution({Id: distributionId}, function(err, data) {
    if (err) return callback(err);

    callback(null, data.Distribution.Status);
  });
};

DomainManager.prototype.deleteCdnDistribution = function(distributionId, callback) {
  debug('delete CloudFront distribution %s', distributionId);

  // The ACM certificate is still attached to the CloudFront distribution. We can't delete
  // the certificate right now because the deleteDistribution action takes time to complete.
  // Trying to delete the certificate at this point will result in a "still in use" error.
  // Will need a background job that cleans up unused certificates periodically.
  this._cloudFront.deleteDistribution({Id: distributionId}, callback);
};

// Get the status of the certificate
DomainManager.prototype.getCertificateStatus = function(certificateId, callback) {
  this._certManager.describeCertificate({CertificateArn: certificateId}, function(err, data) {
    if (err) return callback(err);

    callback(null, data.Certificate.Status);
  });
};

DomainManager.prototype.deleteCertificate = function(certificateId, callback) {
  debug('delete certificate', certificateId);
  // Delete the ACM certificate
  this._certManager.deleteCertificate({CertificateArn: certificateId}, function(err) {
    if (err && err.code !== 'NoSuchEntity') return callback(err);
    callback();
  });
};

DomainManager.prototype.unregisterLegacyDomain = function(domainName, distributionId, callback) {
  debug('unregister legacy domain %s', domainName);
  var self = this;
  var config;
  var etag;
  async.series([
    function(cb) {
      self._cloudFront.getDistributionConfig({Id: distributionId}, function(err, data) {
        if (err && err.code !== 'NoSuchDistribution') {
          debug('could not find distribution %s', distributionId);
          return cb(err);
        }
        config = data.DistributionConfig;
        etag = data.ETag;
        cb();
      });
    },
    function(cb) {
      if (!config) return cb();
      var aliases = config.Aliases.Items;
      if (_.contains(aliases, domainName)) {
        config.Aliases.Items = _.without(aliases, domainName);
        config.Aliases.Quantity = config.Aliases.Items.length;
        self._cloudFront.updateDistribution({
          Id: distributionId,
          DistributionConfig: config,
          IfMatch: etag
        }, cb);
      } else {
        cb();
      }
    }
  ], callback);
};

DomainManager.prototype.legacyDomainRegistered = function(domainName, callback) {
  var self = this;
  var foundDomain;
  async.eachSeries(this._settings.cloudFrontDistributions, function(distributionId, cb) {
    if (foundDomain) return cb();
    self._cloudFront.getDistributionConfig({Id: distributionId}, function(err, data) {
      if (err) return cb(err);
      foundDomain = _.contains(data.DistributionConfig.Aliases.Items, domainName);
      cb();
    });
  }, function(err) {
    callback(err, foundDomain);
  });
};

DomainManager.prototype.resendValidationEmail = function(domainName, certificateId, callback) {
  var params = {
    CertificateArn: certificateId,
    Domain: domainName,
    ValidationDomain: domainName
  };

  this._certManager.resendValidationEmail(params, callback);
};
