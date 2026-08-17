'use strict'

// Config-driven nodemailer wrapper. The transport is built from config.get('email')
// so production (SMTP relay) and dev (local sendmail / different relay) pick up their
// own settings from the same config file. See config.js for the defaults block and
// p3api.conf for the real production SMTP credentials.

const nodemailer = require('nodemailer')
const Config = require('../config')
const debug = require('debug')('p3api-server:mailer')

let transport

function getTransport () {
  if (transport) { return transport }

  const mailconf = Config.get('email') || {}

  if (mailconf.localSendmail) {
    transport = nodemailer.createTransport({ sendmail: true, newline: 'unix' })
  } else {
    const opts = {
      host: mailconf.host || 'localhost',
      port: mailconf.port || 25
    }
    if (mailconf.username) {
      opts.auth = { user: mailconf.username, pass: mailconf.password }
    }
    opts.tls = { rejectUnauthorized: true }
    transport = nodemailer.createTransport(opts)
  }

  return transport
}

// Strip CR/LF/null to prevent header injection from any interpolated value.
function sanitizeHeader (val) {
  return String(val == null ? '' : val).replace(/[\r\n\0]/g, '')
}

/**
 * Send a plain-text report email.
 * @param {object} msg - { to, subject, text, from? }
 * @returns {Promise} resolves with nodemailer info, rejects on send failure.
 */
function sendReport (msg) {
  return new Promise((resolve, reject) => {
    const mailconf = Config.get('email') || {}
    const from = sanitizeHeader(msg.from || mailconf.defaultFrom || 'BV-BRC <do-not-reply@bv-brc.org>')
    const to = sanitizeHeader(msg.to)
    const subject = sanitizeHeader(msg.subject).slice(0, 200)

    if (!to) {
      reject(new Error('sendReport: no recipient (to) given'))
      return
    }

    getTransport().sendMail({
      from: from,
      to: to,
      subject: subject,
      text: String(msg.text == null ? '' : msg.text)
    }, (err, info) => {
      if (err) {
        debug('Mail send failed: %s', err)
        reject(err)
        return
      }
      debug('Mail sent: %o', info && info.messageId)
      resolve(info)
    })
  })
}

module.exports = { sendReport, sanitizeHeader }
