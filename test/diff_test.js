// main.js 의 diff 코어를 그대로 떼어 node 에서 검증하는 스모크 테스트
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

// IIFE 내부 함수들을 추출해 평가할 수 있게 래핑
const extract = (name) => {
    const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n    \\}', 'm');
    const m = src.match(re);
    if (!m) { throw new Error('함수 추출 실패: ' + name); }
    return m[0];
};
const code = [
    src.match(/function splitLines[\s\S]*?\n    \}/m)[0],
    extract('pushOp'),
    extract('patienceAnchors'),
    extract('pdiff'),
    extract('diffOps')
].join('\n');
eval(code);

let fail = 0;
function check(name, cond) {
    if (!cond) { fail++; console.error('  ✗ ' + name); }
    else { console.log('  ✓ ' + name); }
}

// ops 적용 결과가 원본을 재구성하는지 (a 소비량 / b 생산량 검증)
function applyOps(a, b, ops) {
    let ai = 0, bi = 0;
    const out = [];
    for (const op of ops) {
        if (op.t === 's') {
            for (let n = 0; n < op.n; n++) {
                if (a[ai] !== b[bi]) { throw new Error('same 인데 줄 불일치: a[' + ai + ']'); }
                out.push(b[bi]); ai++; bi++;
            }
        } else if (op.t === 'd') { ai += op.n; }
        else { for (let n = 0; n < op.n; n++) { out.push(b[bi++]); } }
    }
    if (ai !== a.length) { throw new Error('a 소비 불일치 ' + ai + '/' + a.length); }
    if (bi !== b.length) { throw new Error('b 소비 불일치 ' + bi + '/' + b.length); }
    return out;
}

function run(name, a, b) {
    const ops = diffOps(a, b);
    const rebuilt = applyOps(a, b, ops);
    check(name + ' — 재구성 일치', JSON.stringify(rebuilt) === JSON.stringify(b));
    return ops;
}

console.log('diff 코어 스모크 테스트');

// 기본 케이스
run('동일 파일', ['a', 'b', 'c'], ['a', 'b', 'c']);
run('빈 vs 내용', [], ['a', 'b']);
run('내용 vs 빈', ['a', 'b'], []);
run('둘 다 빈', [], []);
run('중간 수정', ['a', 'b', 'c', 'd'], ['a', 'X', 'c', 'd']);
run('삽입', ['a', 'b'], ['a', 'n1', 'n2', 'b']);
run('삭제', ['a', 'x', 'y', 'b'], ['a', 'b']);
run('전부 교체', ['1', '2'], ['x', 'y', 'z']);
run('중복 줄 포함', ['a', 'a', 'b', 'a'], ['a', 'b', 'a', 'a']);
run('앞뒤 공통 + 중간 이동', ['h', 'p', 'q', 'r', 't'], ['h', 'r', 'p', 'q', 't']);

// same 비율 sanity — 동일 파일이면 전부 same 한 덩어리
const opsSame = diffOps(['x', 'y'], ['x', 'y']);
check('동일 파일 ops = same 1개', opsSame.length === 1 && opsSame[0].t === 's' && opsSame[0].n === 2);

// 큰 파일 성능
const big1 = [], big2 = [];
for (let i = 0; i < 20000; i++) { big1.push('line ' + i); big2.push('line ' + i); }
big2[5000] = 'changed!';
big2.splice(15000, 0, 'inserted!');
const t0 = Date.now();
run('2만 줄 파일', big1, big2);
const ms = Date.now() - t0;
check('2만 줄 1초 이내 (' + ms + 'ms)', ms < 1000);

// splitLines
check('splitLines 마지막 개행', JSON.stringify(splitLines('a\nb\n')) === '["a","b"]');
check('splitLines 개행 없음', JSON.stringify(splitLines('a\nb')) === '["a","b"]');
check('splitLines 빈 문자열', JSON.stringify(splitLines('')) === '[]');
check('splitLines CRLF', JSON.stringify(splitLines('a\r\nb\r\n')) === '["a","b"]');

process.exit(fail ? 1 : 0);
