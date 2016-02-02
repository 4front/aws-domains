/* eslint no-console: 0 */

var DomainManager = require('./');

var domains = new DomainManager({
  cloudFrontOriginDomain: 'origin.aerobatic.io',
  cloudFrontLogBucket: 'aerobatic-cloudfront-logs.s3.amazonaws.com',
  certificateManagerRegion: 'us-east-1',
  cloudFrontCustomErrorsDomain: 'aerobatic-media.s3.amazonaws.com',
  cloudFrontCustomErrorsPath: '/__cloudfront-errors',
  cloudFrontNoCachePathPattern: '/__nocdn/*'
});

// domains.uploadServerCertificate({
//   certificateBody: fs.readFileSync('/Users/david/src/startssl/jsngin/cert.key').toString(),
//   privateKey: fs.readFileSync('/Users/david/src/startssl/jsngin/private.key').toString(),
//   certificateChain: fs.readFileSync('/Users/david/src/startssl/jsngin/certchain.pem').toString()
// }, function(err, certificate) {
//   if (err) {
//     console.error(err);
//   } else {
//     console.log(certificate);
//   }
// });

// domains.requestWildcardCertificate('vonlehman.net', function(err, certId) {
//   if (err) {
//     return console.error(err);
//   }
//
//   console.log(certId);
// });
