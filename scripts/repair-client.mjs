// Repair the plugin's client bundle: a shell round-trip mangled its non-ASCII
// bytes. The ASCII structure is intact, so this rewrites the one non-ASCII
// dictionary block and neutralises any leftover broken characters.
import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
const text = readFileSync(path).toString('utf8')

const zhBlock = [
  '    const zh = {',
  "      'menu.deleteSession': '删除会话',",
  "      'prompt.edit': '编辑提问',",
  "      'prompt.delete': '删除提问',",
  "      'reply.delete': '删除回答',",
  "      'edit.title': '编辑第 {turn} 轮提问',",
  "      'edit.body': '发送会替换这条提问：它的回答以及之后的内容都会被移除，编辑后的文本会放进输入框——在输入框按发送即可得到新回答。',",
  "      'edit.send': '发送',",
  "      'edit.busy': '替换中…',",
  "      'edit.done': '已替换',",
  "      'dialog.session.title': '确定删除这个会话？',",
  "      'dialog.session.body': '将从磁盘移除该会话：日志、投影缓存以及侧边栏成员关系都会被删除。应用内无法撤销。',",
  "      'dialog.prompt.title': '确定删除第 {turn} 轮提问？',",
  "      'dialog.prompt.body': '这一轮提问、它的回答以及之后的所有轮次都会从日志中移除，之前的轮次保留。改写前原日志会备份到插件备份目录。',",
  "      'dialog.reply.title': '确定删除这条回答？',",
  "      'dialog.reply.body': '第 {turn} 轮的回答及之后的内容都会被移除，提问本身保留。改写前原日志会备份到插件备份目录。',",
  "      'dialog.confirm': '删除',",
  "      'dialog.cancel': '取消',",
  "      'dialog.busy': '删除中…',",
  "      'dialog.done': '已删除',",
  "      'dialog.error': '删除失败：{message}',",
  "      'notice.title': '已经从磁盘删除',",
  "      'notice.session.body': '删除已经落盘，但当前 Harness 进程仍把该会话保存在内存里，所以列表里还看得到。关闭并重新打开 DeepSeek Harness 即可刷新列表。',",
  "      'notice.turn.body': '删除已经落盘，但当前 Harness 仍在返回它打开会话时载入的那份副本，所以对话里还看得到。关闭并重新打开 DeepSeek Harness 即可刷新对话。',",
  "      'notice.close': '我知道了'",
  '    }'
].join('\n')

const start = text.indexOf('    const zh = {')
const endMarker = "\n    }\n"
const end = start === -1 ? -1 : text.indexOf(endMarker, start)
if (start === -1 || end === -1) {
  console.log('could not locate the zh dictionary block')
  process.exit(1)
}
let repaired = `${text.slice(0, start)}${zhBlock}${text.slice(end + endMarker.length - 1)}`

// Anything still unreadable becomes plain ASCII so the bundle stays valid UTF-8.
const before = (repaired.match(/\uFFFD/g) ?? []).length
repaired = repaired.replace(/\uFFFD+/g, '...')

// The English copy must be ASCII too: the same round-trip may have hit ellipses.
repaired = repaired.replace(/'Deleting\u2026'/g, "'Deleting...'")

writeFileSync(path, repaired)
console.log(`repaired ${path}: replaced ${before} broken character runs, zh block restored`)
