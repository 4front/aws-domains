var AWS = require('aws-sdk');
var shortid = require('shortid');
var async = require('async');
var _ = require('lodash');
var debug = require('debug')('4front:aws-domains');

require('simple-errors');

module.exports = DomainManager = function(settings) {
  this._cloudFront = new AWS.CloudFront();

  // The default limit on CNAMEs for a CloudFront distribution is 200
  // However it should be possible to request more.
  this._settings = _.defaults({}, settings, {
    maxAliasesPerDistribution: 200
  });
};

DomainManager.prototype.register = function(domainName, callback) {
  var self = this;

  debug("register domain %s", domainName);

  // Cycle through the list of domains looking for one with availability.
  var i = 0;
  var distribution = null;

  this._findDistribution(self._settings.cloudFrontDistributions, function(distro) {
    return distro.DistributionConfig.Aliases.Quantity < self._settings.maxAliasesPerDistribution;
  }, function(err, distro) {
    if (err) return callback(err);

    if (!distro)
      return callback(new Error("No CloudFront distributions with available CNAME aliases"));

    var aliases = distro.Distribution.DistributionConfig.Aliases;
    aliases.Items.push(domainName);
    aliases.Quantity += 1;

    self._updateDistribution(distro, callback);
  });
};

DomainManager.prototype.unregister = function(domainName, distributionId, callback) {
  var self = this;

  debug("unregister the CNAME %s", domainName);
  // Load the distribution

  // If a distributionId was specified, just search that one. Otherwise
  // scan through all of them until one is found that contains the CNAME.
  var distributionsToSearch;
  if (distributionId)
    distributionsToSearch = [distributionId];
  else
    distributionsToSearch = this._settings.cloudFrontDistributions;

  function test(distro) {
    // Check if this distribution contains the specified CNAME
    return _.indexOf(distro.DistributionConfig.Aliases.Items, domainName) !== -1;
  }

  this._findDistribution(distributionsToSearch, test, function(err, distro) {
    if (err) return callback(err);

    if (!distro) {
      debug("did not find domain %s to unregister", domainName);
      return callback();
    }

    var aliases = distro.Distribution.DistributionConfig.Aliases;
    var index = _.indexOf(aliases.Items, domainName);
    if (index === -1)
      return callback();

    _.pullAt(aliases.Items, index);
    aliases.Quantity = aliases.Items.length;

    self._updateDistribution(distro, callback);
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
    self._cloudFront.getDistribution({Id: distributionIds[i]}, function(err, distro) {
      if (err) return cb(err);

      if (!distro)
        return callback(Error.create("No distribution with id " + distributionIds[i], {code: "invalidDistribution"}));

      if (test(distro.Distribution))
        found = distro;

      i++;
      cb();
    });
  }, function(err) {
    if (err) return callback(err);

    callback(null, found);
  });
}

DomainManager.prototype._updateDistribution = function(distribution, callback) {
  // Finally update the distribution
  this._cloudFront.updateDistribution({
    Id: distribution.Distribution.Id,
    DistributionConfig: distribution.Distribution.DistributionConfig,
    IfMatch: distribution.ETag
  }, function(err, data) {
    if (err) return callback(err);

    // Return the distributionId in the callback
    callback(null, data.Distribution.Id);
  });
};
