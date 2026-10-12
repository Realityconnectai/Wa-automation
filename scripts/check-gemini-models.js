#!/usr/bin/env node
/**
 * scripts/check-gemini-models.js
 *
 * Checks which models listed in src/services/gemini-client.js ALL_GEMINI_MODELS
 * are actually available on the Gemini API for the given key.
 *
 * SECURITY: reads the API key from TEST_GEMINI_KEY only.
 *   - Never reads from .env or GEMINI_API_KEY (production key).
 *   - Never prints the key, a prefix of the key, or its length.
 *   - Prints only valid/invalid status per model name.
 *
 * USAGE (owner runs this manually):
 *   TEST_GEMINI_KEY=your_test_key node scripts/check-gemini-models.js
 *
 * Does nothing (exits 0 with instructions) if TEST_GEMINI_KEY is not set.
 */
'use strict';

const key = process.env.TEST_GEMINI_KEY;

if (!key || key.trim() === '') {
    console.log('');
    console.log('Gemini model checker — not running (TEST_GEMINI_KEY is not set).');
    console.log('');
    console.log('To run this check, set a THROWAWAY test API key (not your production key):');
    console.log('');
    console.log('  Windows PowerShell:');
    console.log('    $env:TEST_GEMINI_KEY="AIza..."');
    console.log('    node scripts/check-gemini-models.js');
    console.log('');
    console.log('  macOS / Linux:');
    console.log('    TEST_GEMINI_KEY="AIza..." node scripts/check-gemini-models.js');
    console.log('');
    console.log('Get a free test key at: https://aistudio.google.com/app/apikey');
    console.log('Use a key that is OK to expose — do not paste your production GEMINI_API_KEY here.');
    console.log('');
    process.exit(0);
}

// Never log the key. Verify it looks like a Google AI key but don't act on shape alone.
if (!/^AIza/.test(key.trim())) {
    console.error('ERROR: TEST_GEMINI_KEY does not look like a Google AI key (expected to start with "AIza").');
    console.error('       Do not print the key. Check it is correct and try again.');
    process.exit(1);
}

async function main() {
    // Load the model list from the actual source module — so this script
    // always reflects the current state of gemini-client.js, not a copy.
    const { ALL_GEMINI_MODELS } = require('../src/services/gemini-client');

    let GoogleGenAI;
    try {
        ({ GoogleGenAI } = require('@google/genai'));
    } catch (e) {
        console.error('ERROR: @google/genai is not installed. Run: npm install');
        process.exit(1);
    }

    const ai = new GoogleGenAI({ apiKey: key.trim() });

    console.log('');
    console.log('Fetching available Gemini models from API...');
    console.log('');

    let availableModels;
    try {
        // List all models the key has access to.
        // GoogleGenAI.models.list() returns a pager; collect all names.
        const pager = await ai.models.list();
        availableModels = new Set();
        for await (const model of pager) {
            // model.name is like "models/gemini-2.5-flash" — strip prefix
            const shortName = (model.name || '').replace(/^models\//, '');
            availableModels.add(shortName);
            availableModels.add(model.name); // also store with prefix for safety
        }
    } catch (err) {
        // Print error type and message but NOT the key
        console.error(`ERROR: Could not list models: ${err.message}`);
        if (err.status === 400 || err.status === 401 || err.status === 403) {
            console.error('       The key may be invalid, expired, or lack permission to list models.');
        }
        process.exit(1);
    }

    console.log(`Models in src/services/gemini-client.js ALL_GEMINI_MODELS (${ALL_GEMINI_MODELS.length} total):`);
    console.log('');

    let validCount   = 0;
    let invalidCount = 0;

    for (const model of ALL_GEMINI_MODELS) {
        // Check both "gemini-x.y-flash" and "models/gemini-x.y-flash"
        const isValid = availableModels.has(model) || availableModels.has(`models/${model}`);
        if (isValid) {
            console.log(`  ✅  ${model}`);
            validCount++;
        } else {
            console.log(`  ❌  ${model}  ← NOT available for this key`);
            invalidCount++;
        }
    }

    console.log('');
    console.log(`Result: ${validCount} valid, ${invalidCount} invalid`);

    if (invalidCount > 0) {
        console.log('');
        console.log('⚠️  Invalid model names will cause the circuit breaker to open after all');
        console.log('   retries are exhausted, silently disabling AI replies for all tenants.');
        console.log('');
        console.log('Available models on this key (for reference):');
        const names = [...availableModels]
            .filter(n => n.includes('gemini'))
            .sort()
            .map(n => n.replace(/^models\//, ''))
            .filter((v, i, a) => a.indexOf(v) === i); // dedupe
        for (const n of names) {
            console.log(`    ${n}`);
        }
        console.log('');
        console.log('Update ALL_GEMINI_MODELS in src/services/gemini-client.js with the');
        console.log('valid names above, then send the output to the developer.');
        process.exit(1); // Non-zero so CI can gate on this
    } else {
        console.log('');
        console.log('✅  All model names are valid. No changes needed.');
        process.exit(0);
    }
}

main().catch(err => {
    // Print error but never the key
    console.error('Unexpected error:', err.message);
    process.exit(1);
});
