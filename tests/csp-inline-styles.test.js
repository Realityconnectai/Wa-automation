'use strict';

const fs = require('fs');
const path = require('path');

describe('CSP Inline Style & Font Scan', () => {
    test('public HTML and JS files must not contain inline style attributes', () => {
        const root = path.join(__dirname, '..', 'public');
        const violations = [];

        function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (/\.(?:html|js)$/i.test(entry.name) && entry.name !== 'chart.umd.min.js') {
                    const text = fs.readFileSync(fullPath, 'utf8');
                    for (const match of text.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/g)) {
                        const line = text.slice(0, match.index).split(/\r?\n/).length;
                        violations.push(`${path.relative(root, fullPath)}:${line} -> style="${match[2]}"`);
                    }
                }
            }
        }

        walk(root);
        expect(violations).toEqual([]);
    });

    test('public CSS files must not import external Google Fonts stylesheets', () => {
        const root = path.join(__dirname, '..', 'public', 'css');
        for (const file of fs.readdirSync(root)) {
            if (file.endsWith('.css')) {
                const text = fs.readFileSync(path.join(root, file), 'utf8');
                expect(text).not.toMatch(/fonts\.googleapis\.com/);
            }
        }
    });
});
