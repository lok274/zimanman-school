import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root = path.dirname(fileURLToPath(import.meta.url));
const sourceExport = fs.existsSync(path.join(root, 'shared/quiz-results.js'));
const source = sourceExport ? 'shared/quiz-results.js' : '../dist/quiz-results.js';
const canonical = fs.readFileSync(path.join(root, source), 'utf8');
const shared = name => fs.readFileSync(path.join(root, sourceExport ? 'shared/' + name : '../dist/' + name), 'utf8');
const assessment = shared('assessment.js');
const characterData = shared('character-data.js');
const automaticSchema = fs.readFileSync(path.join(root, 'drizzle/0002_automatic_submissions.sql'), 'utf8').trim();
const characterContext = vm.createContext({});
vm.runInContext(characterData + '\n' + shared('data/characters.js'), characterContext);
const targetCounts = Object.fromEntries(Object.entries(characterContext.BishunCharacters).map(([character, data]) => [character, characterContext.BishunCharacterData.validateCharacter(character, data).strokes.length]));
const context = vm.createContext({});
vm.runInContext(shared('content.js'), context);
const dataUrl = context.BishunContent.dataUrl;
const defaults = context.BishunContent.words.map(text => ({ text, selectedIndexes: Array.from(text, (_, index) => index) }));
const teacherScripts = [canonical, assessment, shared('freehand.js'), shared('assessment-review.js')].join('\n');
const teacherTemplate = fs.readFileSync(path.join(root, 'src/teacher.html'), 'utf8').replace('__DEFAULT_ENTRIES__', JSON.stringify(defaults))
  .replace('__ASSESSMENT_SCRIPTS__', () => teacherScripts.replace(/<\/script/gi, '<\\/script'))
  .replace('__ASSESSMENT_CSS__', () => shared('assessment.css'));
const teacher = teacherTemplate.replace('__API_ORIGIN__', JSON.stringify(''));
if (!sourceExport) {
  vm.runInContext(shared('classroom.js'), context);
  const defaultOrigin = context.BishunClassroom.defaultOrigin;
  if (!defaultOrigin || new URL(defaultOrigin).origin !== defaultOrigin) throw new Error('Classroom default must be an absolute API origin.');
  fs.writeFileSync(path.join(root, '../dist/teacher.html'), teacherTemplate.replace('__API_ORIGIN__', JSON.stringify(defaultOrigin)));
}
fs.writeFileSync(path.join(root, 'src/quiz-results.js'), canonical + '\nexport default globalThis.BishunQuizResults;\n');
fs.writeFileSync(path.join(root, 'src/assessment.js'), assessment + '\nexport default globalThis.BishunAssessment;\n');
fs.writeFileSync(path.join(root, 'src/teacher-page.js'), 'export default ' + JSON.stringify(teacher) + ';\n');
fs.writeFileSync(path.join(root, 'src/character-data.js'), characterData + '\nexport default globalThis.BishunCharacterData;\n');
fs.writeFileSync(path.join(root, 'src/automatic-schema.js'), 'export default ' + JSON.stringify(automaticSchema) + ';\n');
fs.writeFileSync(path.join(root, 'src/target-counts.js'), 'export const counts = ' + JSON.stringify(targetCounts) + ';\nexport const dataUrl = ' + JSON.stringify(dataUrl) + ';\n');
const worker = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8')
  .replace("import D from './character-data.js';", characterData + '\nconst D = globalThis.BishunCharacterData;')
  .replace("import automaticSchema from './automatic-schema.js';", 'const automaticSchema = ' + JSON.stringify(automaticSchema) + ';')
  .replace("import { counts, dataUrl } from './target-counts.js';", 'const counts = ' + JSON.stringify(targetCounts) + ', dataUrl = ' + JSON.stringify(dataUrl) + ';')
  .replace("import Q from './quiz-results.js';", canonical + '\nconst Q = globalThis.BishunQuizResults;')
  .replace("import A from './assessment.js';", assessment + '\nconst A = globalThis.BishunAssessment;')
  .replace("import teacherHTML from './teacher-page.js';", 'const teacherHTML = ' + JSON.stringify(teacher) + ';');
fs.mkdirSync(path.join(root, 'dist/server'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/server/index.js'), worker);
console.log('Built dist/server/index.js from canonical content, quiz scorer and Worker source.');
