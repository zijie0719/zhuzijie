'use strict';

/**
 * 清空数据，恢复到「首次启动」的状态。
 *
 *   npm run reset            只删数据库（商品、订单、卡密、设置全没了）
 *   npm run reset -- --uploads   连上传的图片一起删
 *
 * 必须加 --yes 才会真的执行，防止手滑。
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'public', 'uploads');

const args = process.argv.slice(2);
const withUploads = args.includes('--uploads');
const confirmed = args.includes('--yes');

const targets = [];
if (fs.existsSync(DATA_DIR)) targets.push(DATA_DIR);
if (withUploads && fs.existsSync(UPLOAD_DIR)) targets.push(UPLOAD_DIR);

if (!targets.length) {
  console.log('没有需要清理的数据，已经是干净的了。');
  process.exit(0);
}

console.log('将要删除以下目录：');
targets.forEach((t) => console.log('  · ' + path.relative(ROOT, t)));

if (!confirmed) {
  console.log('\n这会清空所有商品、订单、卡密和设置。');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('确定要继续吗？输入 yes 确认：', (answer) => {
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('已取消，什么都没删。');
      process.exit(0);
    }
    wipe();
  });
} else {
  wipe();
}

function wipe() {
  for (const dir of targets) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('已删除 ' + path.relative(ROOT, dir));
  }
  console.log('\n完成。下次 npm start 会重新初始化数据库，并生成默认管理员 admin / admin123。');
}
