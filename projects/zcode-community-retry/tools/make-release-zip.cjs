#!/usr/bin/env node
// Builds the release archive with forward-slash entry names so it extracts on
// every platform (PowerShell's Compress-Archive writes backslashes).
// Usage: node tools/make-release-zip.cjs <source-dir> <output.zip> [top-folder-name]
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const [source, output, topName] = process.argv.slice(2)
if (!source || !output) {
  console.error('Usage: node tools/make-release-zip.cjs <source-dir> <output.zip> [top-folder-name]')
  process.exit(1)
}

const rootName = topName || path.basename(path.resolve(source))
const table = (() => {
  const values = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    values[n] = c >>> 0
  }
  return values
})()
const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const dosTime = (date) => ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff
const dosDate = (date) => (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.name !== '.git' && entry.name !== 'dist' && entry.name !== 'node_modules')
  .flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])

const files = walk(path.resolve(source)).sort()
const locals = []
const centrals = []
let offset = 0
for (const file of files) {
  const name = `${rootName}/${path.relative(path.resolve(source), file).split(path.sep).join('/')}`
  const input = fs.readFileSync(file)
  const data = zlib.deflateRawSync(input, { level: 9 })
  const stat = fs.statSync(file)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6)
  header.writeUInt16LE(8, 8); header.writeUInt16LE(dosTime(stat.mtime), 10); header.writeUInt16LE(dosDate(stat.mtime), 12)
  header.writeUInt32LE(crc32(input), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(input.length, 22)
  header.writeUInt16LE(Buffer.byteLength(name), 26); header.writeUInt16LE(0, 28)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(dosTime(stat.mtime), 12); central.writeUInt16LE(dosDate(stat.mtime), 14)
  central.writeUInt32LE(crc32(input), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(input.length, 24)
  central.writeUInt16LE(Buffer.byteLength(name), 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42)
  locals.push(header, Buffer.from(name), data)
  centrals.push(central, Buffer.from(name))
  offset += header.length + Buffer.byteLength(name) + data.length
}

const directory = Buffer.concat(centrals)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true })
fs.writeFileSync(output, Buffer.concat([...locals, directory, end]))
console.log(JSON.stringify({ output: path.resolve(output), entries: files.length, bytes: fs.statSync(output).size }))
