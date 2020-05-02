const pino = require('pino')

// initialize counters
let cnt_req = 0;
let cnt_res_ok = 0;
let cnt_res_err = 0;

const dest = pino.destination('reqeusts_per_min.log')
const logger = pino({
    timestamp: pino.stdTimeFunctions.isoTime
}, dest)

setInterval(function() {
    logger.info({total: cnt_req, ok: cnt_res_ok, error: cnt_res_err});
    cnt_req = 0;
    cnt_res_ok = 0;
    cnt_res_err = 0;
}, 60 * 1000);

module.exports = function(req, res, next) {

    cnt_req++;
    if (res.statusCode == 200) {
        cnt_res_ok++;
    } else {
        cnt_res_err++;
    }

    next()
}