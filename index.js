var AWS = require('aws-sdk');
var async = require('async');
var _ = require('lodash');
var x509 = require('x509.js');
var sha1 = require('sha1');
var dateFormat = require('date-format');
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

DomainManager.prototype.register = function(domainName, zone, callback) {
  var self = this;
  var distributionId = zone;

  debug('register domain %s', domainName);

  async.waterfall([
    function(cb) {
      // If a dedicated distributionId is specified, get that distribution. Otherwise find a shared
      // distribution with available CNAME slots.
      if (distributionId) {
        self._getDistribution(distributionId, cb);
      } else {
        self._findNonSslDistribution(cb);
      }
    },
    function(distro, cb) {
      if (!distro) {
        return cb(Error.create('Cannot register domain with non-existent distribution'));
      }

      var aliases = distro.Distribution.DistributionConfig.Aliases;
      // Check if the domain name is already in the list of aliases.
      if (_.contains(aliases.Items, domainName)) {
        return callback(Error.create('CNAME already exists', {code: 'CNAMEAlreadyExists', log: false}));
      }

      aliases.Items.push(domainName);
      aliases.Quantity += 1;

      self._updateDistribution(distro, cb);
    }
  ], callback);
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

DomainManager.prototype.getCertificateStatus = function(certificate, callback) {
  this._cloudFront.getDistribution({
    Id: certificate.zone
  }, function(err, data) {
    if (err) return callback(err);

    callback(null, data.Distribution.Status);
  });
};

// Transfer domain from one zone to another zone. If the targetZone is null, then
// find the first available zone for non-SSL domains.
DomainManager.prototype.transferDomain = function(domainName, currentZone, targetZone, callback) {
  var currentDistributionId = currentZone;
  var targetDistributionId = targetZone;

  if (currentDistributionId === targetDistributionId) return callback();
  debug('transfer domain %s from distribution %s to distribution %s', domainName, currentZone, targetZone);

  var self = this;

  async.waterfall([
    function(cb) {
      self.unregister(domainName, currentDistributionId, cb);
    },
    function(domain, cb) {
      self.register(domainName, targetDistributionId, cb);
    }
  ], callback);
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

DomainManager.prototype.uploadCertificate = function(certificate, options, callback) {
  var self = this;
  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }

  // Parse the public key
  var certMetadata;
  try {
    certMetadata = x509.parseCert(certificate.certificateBody);
  } catch (err) {
    return callback(Error.create('Could not parse certificate body. Ensure the certificate is PEM encoded.', {
      code: 'malformedCertificate',
      badRequest: true,
      log: false
    }));
  }

  certificate.commonName = certMetadata.subject.commonName;

  // If this is a wildcard certificate starting with a *, replace the asterisk
  // with an @ symbol since IAM will not accept a certs with * in the name.
  if (certificate.commonName.substr(0, 2) === '*.') {
    certificate.name = '@.' + certificate.commonName.slice(2);
  } else {
    certificate.name = certificate.commonName;
  }

  // Tack a timestamp onto the certname. We need to have two certs with the
  // same common name during the renewal interval when Cloudfront is migrating
  // from the old version to the new version to avoid any SSL service interruption.
  certificate.name += ('-' + dateFormat('yyyy-MM-dd-hh-mm', new Date()));

  if (_.isArray(certMetadata.altNames)) {
    certificate.altNames = certMetadata.altNames;
  }

  async.series([
    function(cb) {
      debug('create certificate', certificate.name);
      var params = {
        Path: '/cloudfront/' + self._settings.serverCertificatePathPrefix + certificate.commonName + '/',
        ServerCertificateName: certificate.name,
        CertificateBody: certificate.certificateBody,
        PrivateKey: certificate.privateKey,
        CertificateChain: certificate.certificateChain
      };

      self._iam.uploadServerCertificate(params, function(err, data) {
        if (err) return cb(err);

        debug('created certificate', JSON.stringify(data));

        _.extend(certificate, {
          cname: certificate.commonName,
          status: 'Deployed',
          certificateId: data.ServerCertificateMetadata.ServerCertificateId,
          expires: new Date(data.ServerCertificateMetadata.Expiration),
          uploadDate: new Date(data.ServerCertificateMetadata.UploadDate)
        });

        cb(null);
      });
    },
    function(cb) {
      if (options.skipCloudFrontDistribution === true) return cb();

      // Create a new CloudFront distribution
      debug('creating cloudfront distribution');
      var config = distributionConfig(self._settings, certificate.commonName, certificate);
      self._cloudFront.createDistribution(config, function(err, data) {
        if (err) return cb(err);

        _.extend(certificate, {
          zone: data.Distribution.Id,
          status: data.Distribution.Status,
          cname: data.Distribution.DomainName
        });

        debug('cloudfront distribution created', data.Distribution.Id);
        cb();
      });
    }
  ], function(err) {
    if (err) {
      // Just use the AWS error message text.
      if (err.code === 'MalformedCertificate') {
        return callback(Error.create(err.message, {
          code: 'malformedCertificate',
          certName: certificate.name,
          badRequest: true
        }));
      }

      if (err.code === 'EntityAlreadyExists' && err.message.indexOf('Server Certificate') >= 0) {
        return callback(Error.create('Certficate already exists', {
          code: 'certificateExists',
          certName: certificate.name,
          certDomain: certificate.commonName,
          badRequest: true
        }));
      }

      return callback(err);
    }
    callback(null, certificate);
  });
};

DomainManager.prototype.deleteCertificate = function(certificate, callback) {
  debug('delete certificate', certificate.name);
  // Delete the CloudFront distribution
  var self = this;
  async.series([
    function(cb) {
      if (_.isEmpty(certificate.zone)) return cb();
      self._cloudFront.deleteDistribution({Id: certificate.zone}, cb);
    },
    function(cb) {
      // cb();
      // TODO: Instead make a call to self._certManager.deleteCertificate();
      self._iam.deleteServerCertificate({ServerCertificateName: certificate.name}, cb);
    }
  ], callback);
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
