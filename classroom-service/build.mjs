import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.existsSync(path.join(root, '../dist/quiz-results.js')) ? '../dist/quiz-results.js' : 'shared/quiz-results.js';
const canonical = fs.readFileSync(path.join(root, source), 'utf8');
const teacher = fs.readFileSync(path.join(root, 'src/teacher.html'), 'utf8');
fs.writeFileSync(path.join(root, 'src/quiz-results.js'), canonical + '\nexport default globalThis.BishunQuizResults;\n');
fs.writeFileSync(path.join(root, 'src/teacher-page.js'), 'export default ' + JSON.stringify(teacher) + ';\n');
const worker = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8')
  .replace("import Q from './quiz-results.js';", canonical + '\nconst Q = globalThis.BishunQuizResults;')
  .replace("import teacherHTML from './teacher-page.js';", 'const teacherHTML = ' + JSON.stringify(teacher) + ';');
fs.mkdirSync(path.join(root, 'dist/server'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/server/index.js'), worker);
console.log('Built dist/server/index.js from canonical quiz scorer and Worker source.');
