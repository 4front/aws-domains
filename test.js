/* eslint no-console: 0 */

var DomainManager = require('./');
var fs = require('fs');

var domains = new DomainManager({
  cloudFrontOriginDomain: 'aerobatic-prod.elasticbeanstalk.com',
  cloudFrontLogBucket: 'aerobatic-cloudfront-logs.s3.amazonaws.com'
});

domains.uploadServerCertificate({
  certificateBody: fs.readFileSync('/Users/david/src/startssl/jsngin/cert.key').toString(),
  privateKey: fs.readFileSync('/Users/david/src/startssl/jsngin/private.key').toString(),
  certificateChain: fs.readFileSync('/Users/david/src/startssl/jsngin/certchain.pem').toString()
}, function(err, certificate) {
  if (err) {
    console.error(err);
  } else {
    console.log(certificate);
  }
});