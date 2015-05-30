var AWS = require('aws-sdk');
var shortid = require('shortid');
var async = require('async');
var _ = require('lodash');
var debug = require('debug')('4front:aws-domains');

require('simple-errors');

module.exports = DomainManager = function(settings) {
  this._cloudFront = new AWS.CloudFront();
  this._settings = settings;

  // The default limit on CNAMEs for a CloudFront distribution is 200
  // However it should be possible to request more.
  if (!this._settings.maxAliasesPerDistribution)
    this._settings.maxAliasesPerDistribution = 200;
};

DomainManager.prototype.register = function(domainName, callback) {
  var self = this;

  debug("register domain %s", domainName);

  // Cycle through the list of domains looking for one with availability.
  var i = 0;
  var distribution = null;

  var whileTest = function() {
    return distribution === null && i < self._settings.distributions.length;
  };

  async.whilst(whileTest, function(cb) {
    self._cloudFront.getDistribution({Id: self._settings.distributions[i]}, function(err, distro) {
      if (err) return cb(err);

      var aliases = distro.Distribution.DistributionConfig.Aliases;

      // Check if this domain name already exists
      if (aliases.Items.indexOf(domainName) !== -1)
        return cb(Error.create("The domain name " + domainName + " is already registered in distribution " + distro.Distribution.Id, {code: "domainAlredyRegistered"}));

      // If this distribution is not maxed out on CNAMEs, return
      if (aliases.Quantity < self._settings.maxAliasesPerDistribution) {
        aliases.Items.push(domainName);
        aliases.Quantity += 1;
        distribution = distro;
      }

      i++;
      cb();
    });
  }, function(err) {
    if (err) return callback(err);

    if (!distribution)
      return callback(new Error("No CloudFront distributions with available CNAME aliases"));

    // Finally update the distribution
    self._updateDistribution(distribution, callback);
  });

  DomainManager.prototype.unregister = function(domainName, distributionId, callback) {
    var self = this;

    debug("unregister the CNAME %s", domainName);
    // Load the distribution
    this._cloudFront.getDistribution({Id: distributionId}, function(err, distribution) {
      if (err) return callback(err);

      if (!distribution)
        return callback(Error.create("No distribution with id " + distributionId, {code: "invalidDistribution"}));

      var aliases = distribution.Distribution.DistributionConfig.Aliases;
      var index = _.indexOf(aliases.Items, domainName);
      if (index === -1)
        return callback();

      _.pullAt(aliases.Items, index);
      aliases.Quantity = aliases.Items.length;

      self._updateDistribution(distribution, callback);
    });
  };
};

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
