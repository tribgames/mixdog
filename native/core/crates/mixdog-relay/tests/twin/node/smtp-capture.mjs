#!/usr/bin/env node
// Sends one message through the nodemailer path of lib/feedback.mjs and prints
// the outcome as one JSON line on stdout.
//
// argv[2] is JSON: { host, port, user, pass, timeoutMs?, ca?, treeRoot?, mail }
//   host/port   the SMTP server (the twin's capture server)
//   user/pass   AUTH credentials
//   timeoutMs   connection/greeting/socket/dns timeout (feedback default 15000)
//   ca          PEM text trusted for the server certificate (test CA)
//   mail        the nodemailer message: from, to, replyTo?, subject, text,
//               messageId, attachments?: [{filename, contentBase64,
//               contentType, contentDisposition}]
// The createTransport options are those of nodemailerSender in
// apps/relay/lib/feedback.mjs: secure when port is 465, requireTLS otherwise,
// rejectUnauthorized true, plus the test CA.
// stdout: {"ok":true,"accepted":[..],"rejected":[..],"response":"..","messageId":".."}
//      or {"ok":false,"code":"..","message":".."}
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { resolvePackages } from './relay-host.mjs';

async function capture(request) {
  const { modulesDir } = resolvePackages(request.treeRoot);
  const nodemailer = createRequire(`${modulesDir}/`)('nodemailer');
  const timeoutMs = Number(request.timeoutMs) || 15_000;
  const port = Number(request.port);
  const transport = nodemailer.createTransport({
    host: request.host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: request.user, pass: request.pass },
    tls: { rejectUnauthorized: true, ...(request.ca ? { ca: request.ca } : {}) },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    dnsTimeout: timeoutMs,
  });
  const { attachments, ...mail } = request.mail;
  try {
    const info = await transport.sendMail({
      ...mail,
      ...(attachments
        ? {
            attachments: attachments.map(({ contentBase64, ...rest }) => ({
              ...rest,
              content: Buffer.from(contentBase64, 'base64'),
            })),
          }
        : {}),
    });
    return {
      ok: true,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      messageId: info.messageId,
    };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'error', message: String(error?.message ?? error) };
  } finally {
    transport.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outcome = await capture(JSON.parse(process.argv[2] ?? ''));
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } catch (error) {
    process.stderr.write(`[smtp-capture] ${error?.message || error}\n`);
    process.exit(1);
  }
}
