import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root = path.dirname(fileURLToPath(import.meta.url));
const source = fs.existsSync(path.join(root, '../dist/quiz-results.js')) ? '../dist/quiz-results.js' : 'shared/quiz-results.js';
const canonical = fs.readFileSync(path.join(root, source), 'utf8');
const shared = name => fs.readFileSync(path.join(root, fs.existsSync(path.join(root, '../dist', name)) ? '../dist/' + name : 'shared/' + name), 'utf8');
const assessment = shared('assessment.js');
const contentSource = fs.existsSync(path.join(root, '../dist/content.js')) ? '../dist/content.js' : 'shared/content.js';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, contentSource), 'utf8'), context);
const defaults = context.BishunContent.words.map(text => ({ text, selectedIndexes: Array.from(text, (_, index) => index) }));
const teacherScripts = [canonical, assessment, shared('freehand.js'), shared('assessment-review.js')].join('\n');
const teacher = fs.readFileSync(path.join(root, 'src/teacher.html'), 'utf8').replace('__DEFAULT_ENTRIES__', JSON.stringify(defaults))
  .replace('__ASSESSMENT_SCRIPTS__', () => teacherScripts.replace(/<\/script/gi, '<\\/script'))
  .replace('__ASSESSMENT_CSS__', () => shared('assessment.css'));
fs.writeFileSync(path.join(root, 'src/quiz-results.js'), canonical + '\nexport default globalThis.BishunQuizResults;\n');
fs.writeFileSync(path.join(root, 'src/assessment.js'), assessment + '\nexport default globalThis.BishunAssessment;\n');
fs.writeFileSync(path.join(root, 'src/teacher-page.js'), 'export default ' + JSON.stringify(teacher) + ';\n');
const worker = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8')
  .replace("import Q from './quiz-results.js';", canonical + '\nconst Q = globalThis.BishunQuizResults;')
  .replace("import A from './assessment.js';", assessment + '\nconst A = globalThis.BishunAssessment;')
  .replace("import teacherHTML from './teacher-page.js';", 'const teacherHTML = ' + JSON.stringify(teacher) + ';');
fs.mkdirSync(path.join(root, 'dist/server'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/server/index.js'), worker);
console.log('Built dist/server/index.js from canonical content, quiz scorer and Worker source.');
