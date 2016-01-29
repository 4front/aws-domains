var AWS = require('aws-sdk');
var async = require('async');
var _ = require('lodash');
var sha1 = require('sha1');
var distributionConfig = require('./lib/distribution-config');
var debug = require('debug')('4front:aws-domains');

require('simple-errors');

module.exports = DomainManager;

function DomainManager(settings) {
  this._cloudFront = new AWS.CloudFront();
  this._iam = new AWS.IAM();
  this._certManager = new AWS.ACM(settings.certificateManagerRegion ?
    {region: settings.certificateManagerRegion} : null);
  this._settings = settings;

  // The default limit on CNAMEs for a CloudFront distribution is 200
  // However it should be possible to request more.
  this._settings = _.defaults({}, settings, {
    maxAliasesPerDistribution: 100
  });
}

DomainManager.prototype.createCdnDistribution = function(topLevelDomain, certificateId, callback) {
  // Name the distribution after the topLevelDomain, i.e. "customdomain.com"
  var config = distributionConfig(this._settings, topLevelDomain, certificateId);

  this._cloudFront.createDistribution(config, function(err, data) {
    if (err) return callback(err);

    callback(null, {
      distributionId: data.Distribution.Id,
      status: data.Distribution.Status,
      domainName: data.Distribution.DomainName
    });
  });
};

DomainManager.prototype.unregister = function(domainName, distributionId, callback) {
  var self = this;

  debug('unregister the CNAME %s from distribution %s', domainName, distributionId);
  // Load the distribution

  // If a distributionId was specified, just search that one. Otherwise
  // scan through all of them until one is found that contains the CNAME.
  var distributionsToSearch;
  if (distributionId) {
    distributionsToSearch = [distributionId];
  } else {
    distributionsToSearch = this._settings.cloudFrontDistributions;
  }

  function test(distro) {
    // Check if this distribution contains the specified CNAME
    return _.indexOf(distro.DistributionConfig.Aliases.Items, domainName) !== -1;
  }

  this._findDistribution(distributionsToSearch, test, function(err, distro) {
    if (err) return callback(err);

    if (!distro) {
      debug('could not find any of distributions %s to unregister domain from', distributionsToSearch);
      return callback();
    }

    var aliases = distro.Distribution.DistributionConfig.Aliases;
    var index = _.indexOf(aliases.Items, domainName);
    if (index === -1) return callback();

    _.pullAt(aliases.Items, index);
    aliases.Quantity = aliases.Items.length;

    self._updateDistribution(distro, callback);
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
  this._cloudFront.deleteDistribution({Id: distributionId}, callback);
};

// Get the status of the certificate
DomainManager.prototype.getCertificateStatus = function(certificateId, callback) {
  this._certManager.describeCertificate({CertificateArn: certificateId}, function(err, data) {
    if (err) return callback(err);

    callback(null, data.Status);
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

// Find one of the shared non-SSL CloudFront distributions that has available
// slots for a CNAME alias.
DomainManager.prototype._findNonSslDistribution = function(callback) {
  var self = this;
  this._findDistribution(this._settings.cloudFrontDistributions, function(distro) {
    return distro.DistributionConfig.Aliases.Quantity < self._settings.maxAliasesPerDistribution;
  }, function(err, distro) {
    if (!distro) {
      return callback(new Error('No CloudFront distributions with available CNAME aliases'));
    }

    callback(null, distro);
  });
};

DomainManager.prototype._getDistribution = function(distributionId, callback) {
  debug('get cloudfront distribution', distributionId);
  this._cloudFront.getDistribution({Id: distributionId}, function(err, distro) {
    if (err) {
      if (err.code === 'NoSuchDistribution') return callback();
      return callback(err);
    }

    callback(null, distro);
  });
};

DomainManager.prototype._findDistribution = function(distributionIds, test, callback) {
  var self = this;

  var found = null;
  var i = 0;
  var whileTest = function() {
    return found === null && i < distributionIds.length;
  };

  async.whilst(whileTest, function(cb) {
    self._getDistribution(distributionIds[i], function(err, distro) {
      if (err) return cb(err);

      if (distro && test(distro.Distribution)) {
        found = distro;
      }

      i++;
      cb();
    });
  }, function(err) {
    if (err) return callback(err);

    callback(null, found);
  });
};

DomainManager.prototype._updateDistribution = function(distribution, callback) {
  debug('update distribution', distribution.Id);

  // Finally update the distribution
  this._cloudFront.updateDistribution({
    Id: distribution.Distribution.Id,
    DistributionConfig: distribution.Distribution.DistributionConfig,
    IfMatch: distribution.ETag
  }, function(err, data) {
    if (err) {
      if (err.code === 'InvalidArgument' && /duplicates/.test(err.message)) {
        return callback(Error.create('CNAME already exists', {code: 'CNAMEAlreadyExists'}));
      }
      return callback(err);
    }

    // Return the distributionId in the callback
    callback(null, data.Distribution.Id);
  });
};

DomainManager.prototype.createSharedDistribution = function(distributionName, callback) {
  // Create a new CloudFront distribution
  debug('creating cloudfront distribution');
  var config = distributionConfig(this._settings, distributionName);
  this._cloudFront.createDistribution(config, function(err, data) {
    if (err) return callback(err);

    debug('cloudfront distribution created', data.Distribution.Id);
    callback(null, data.Distribution);
  });
};
