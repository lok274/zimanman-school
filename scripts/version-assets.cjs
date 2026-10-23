'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const dist = path.join(__dirname, '../dist');
for (const page of ['index.html', 'leaderboard.html']) {
  const file = path.join(dist, page);
  const html = fs.readFileSync(file, 'utf8').replace(/((?:src|href)=")([\w-]+\.(?:js|css))(?:\?v=[^"]*)?"/g, (_, start, asset) => {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(dist, asset), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
    return start + asset + '?v=' + hash + '"';
  });
  fs.writeFileSync(file, html);
}
