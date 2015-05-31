var assert = require('assert');
var _ = require('lodash');
var shortid = require('shortid');
var sinon = require('sinon');
var AWS = require('aws-sdk');
var DomainManager = require('..');

describe('AwsDomainManager', function() {
  var self;

  beforeEach(function() {
    self = this;

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
        var distribution = _.find(self.distributions, function(d) {
          return d.Distribution.Id === params.Id;
        });

        callback(null, distribution);
      }),
      updateDistribution: sinon.spy(function(params, callback) {
        callback(null, {
          Distribution: _.pick(params, 'Id', 'DistributionConfig')
        });
      })
    };

    sinon.stub(AWS, 'CloudFront', function() {
      return self.cloudFrontStub;
    });

    this.domainManager = new DomainManager({
      cloudFrontDistributions: _.map(self.distributions, function(d) {
        return d.Distribution.Id;
      }),
      maxAliasesPerDistribution: 3
    });
  });

  afterEach(function() {
    sinon.restore(AWS, 'CloudFront');
  });

  it('creates CNAME alias in first available distribution', function(done) {
    this.domainManager.register("test.mydomain.com", function(err, distributionId) {
      if (err) return done(err);

      assert.equal(1, self.cloudFrontStub.getDistribution.callCount);
      assert.ok(self.cloudFrontStub.getDistribution.calledWith(sinon.match({
        Id: self.distributions[0].Distribution.Id
      })));

      assert.ok(self.cloudFrontStub.updateDistribution.called);

      var updatedDistribution = self.cloudFrontStub.updateDistribution.getCall(0).args[0];
      assert.deepEqual(updatedDistribution.DistributionConfig.Aliases, {
        Items: ["test.mydomain.com"],
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

    this.domainManager.register("test.mydomain.com", function(err, distributionId) {
      if (err) return done(err);

      var distroIds = _.map(self.distributions, function(d) {
        return d.Distribution.Id;
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
});
