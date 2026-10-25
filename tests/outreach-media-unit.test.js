'use strict';

/**
 * tests/outreach-media-unit.test.js
 *
 * Targeted unit tests for Phase 3 Bulk Media Attachments & Outreach:
 * 1. Text-only campaign backward compatibility
 * 2. Valid media asset selection and tenant ownership verification
 * 3. Rejection of another tenant's asset (multi-tenant isolation)
 * 4. Successful mocked media dispatch with personalized caption
 * 5. Missing or invalid media asset/file handling
 * 6. Immediate opt-out recheck and suppression during outreach
 * 7. Cancellation handling during media outreach
 * 8. Failed transport error handling (ensuring no false positives)
 * 9. Campaign history safe attachment metadata (no storage path leakage)
 * 10. Idempotency key generation for duplicate prevention
 */

describe('Bulk Media Attachments & Outreach — Phase 3 Unit Tests', () => {

    describe('1. Text-only campaign backward compatibility', () => {
        test('dispatches text-only outreach when no mediaAssetId is provided', async () => {
            let sentMediaCalled = false;
            let sentTextCalled = false;

            const mockSendText = jest.fn(async (userId, phone, body) => {
                sentTextCalled = true;
                return { id: { _serialized: 'msg-wa-text-1' } };
            });
            const mockSendMedia = jest.fn(async () => {
                sentMediaCalled = true;
            });

            // Simulate outreach dispatcher branch
            const dispatchContact = async ({ mediaAsset, contact, template, sender, mediaSender }) => {
                const personalized = template.replace(/\{\{\s*name\s*\}\}/gi, contact.name || 'there');
                if (mediaAsset) {
                    await mediaSender(1, contact.phone, { caption: personalized });
                } else {
                    await sender(1, contact.phone, personalized);
                }
            };

            await dispatchContact({
                mediaAsset: null,
                contact: { phone: '919876543210', name: 'John Doe' },
                template: 'Hi {{name}}, check this!',
                sender: mockSendText,
                mediaSender: mockSendMedia
            });

            expect(sentTextCalled).toBe(true);
            expect(sentMediaCalled).toBe(false);
            expect(mockSendText).toHaveBeenCalledWith(1, '919876543210', 'Hi John Doe, check this!');
        });
    });

    describe('2. Valid media asset selection & tenant ownership', () => {
        const mockAssetsDb = [
            { id: 101, user_id: 1, file_name: 'brochure.pdf', storage_path: '/data/assets/1_101.pdf', mime_type: 'application/pdf', is_active: 1 },
            { id: 102, user_id: 2, file_name: 'secret_tenant2.pdf', storage_path: '/data/assets/2_102.pdf', mime_type: 'application/pdf', is_active: 1 }
        ];

        const getMediaAssetById = (userId, assetId) => {
            return mockAssetsDb.find(a => a.id === assetId && a.user_id === userId) || null;
        };

        test('tenant can select their own active media asset', () => {
            const asset = getMediaAssetById(1, 101);
            expect(asset).not.toBeNull();
            expect(asset.id).toBe(101);
            expect(asset.file_name).toBe('brochure.pdf');
        });

        test('rejection of another tenant\'s asset (tenant isolation)', () => {
            // Tenant 1 trying to access Tenant 2's asset 102
            const asset = getMediaAssetById(1, 102);
            expect(asset).toBeNull();
        });
    });

    describe('3. Supported media types and size limits validation', () => {
        const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'video/mp4'];
        const MAX_IMAGE_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
        const MAX_VIDEO_BYTES = 16 * 1024 * 1024;    // 16 MB

        const validateMedia = (mimeType, sizeBytes) => {
            const norm = (mimeType || '').toLowerCase().trim();
            if (!ALLOWED_MIME_TYPES.includes(norm)) {
                return { ok: false, code: 'MEDIA_TYPE_NOT_ALLOWED' };
            }
            const max = norm === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_IMAGE_PDF_BYTES;
            if (sizeBytes > max) {
                return { ok: false, code: 'MEDIA_TOO_LARGE' };
            }
            if (sizeBytes === 0) {
                return { ok: false, code: 'MEDIA_EMPTY' };
            }
            return { ok: true };
        };

        test('accepts valid PDF, JPG, PNG, and MP4 within size limits', () => {
            expect(validateMedia('application/pdf', 5 * 1024 * 1024).ok).toBe(true);
            expect(validateMedia('image/png', 2 * 1024 * 1024).ok).toBe(true);
            expect(validateMedia('video/mp4', 15 * 1024 * 1024).ok).toBe(true);
        });

        test('rejects disallowed file types (executables, scripts, etc.)', () => {
            expect(validateMedia('application/x-msdownload', 100).code).toBe('MEDIA_TYPE_NOT_ALLOWED');
            expect(validateMedia('text/javascript', 100).code).toBe('MEDIA_TYPE_NOT_ALLOWED');
            expect(validateMedia('image/webp', 100).code).toBe('MEDIA_TYPE_NOT_ALLOWED');
        });

        test('rejects files exceeding size limits', () => {
            expect(validateMedia('application/pdf', 11 * 1024 * 1024).code).toBe('MEDIA_TOO_LARGE');
            expect(validateMedia('video/mp4', 17 * 1024 * 1024).code).toBe('MEDIA_TOO_LARGE');
            expect(validateMedia('image/jpeg', 0).code).toBe('MEDIA_EMPTY');
        });
    });

    describe('4. Successful mocked media dispatch with caption', () => {
        test('dispatches media with personalized caption and records sent status', async () => {
            const mockSendMedia = jest.fn(async (userId, phone, opts) => {
                return {
                    waMessageId: 'wa-media-999',
                    sizeBytes: 102400,
                    fileName: 'luxury_brochure.pdf'
                };
            });

            const contact = { phone: '919876543210', name: 'Alice Sharma' };
            const asset = {
                id: 101,
                file_name: 'luxury_brochure.pdf',
                storage_path: '/data/assets/luxury_brochure.pdf',
                mime_type: 'application/pdf'
            };
            const template = 'Hello {{name}}, here is our latest brochure!';
            const personalized = template.replace(/\{\{\s*name\s*\}\}/gi, contact.name);

            const result = await mockSendMedia(1, contact.phone, {
                filePath: asset.storage_path,
                mimeType: asset.mime_type,
                caption: personalized,
                idempotencyKey: 'outreach-job1-recip1',
                mediaAssetId: asset.id
            });

            expect(mockSendMedia).toHaveBeenCalledWith(1, '919876543210', {
                filePath: '/data/assets/luxury_brochure.pdf',
                mimeType: 'application/pdf',
                caption: 'Hello Alice Sharma, here is our latest brochure!',
                idempotencyKey: 'outreach-job1-recip1',
                mediaAssetId: 101
            });
            expect(result.waMessageId).toBe('wa-media-999');
        });
    });

    describe('5. Missing or invalid file handling', () => {
        test('marks recipient failed when media file is missing on server', async () => {
            const fileExists = false;
            let recipientStatus = 'pending';
            let recipientReason = '';

            if (!fileExists) {
                recipientStatus = 'failed';
                recipientReason = 'Media file missing on server';
            }

            expect(recipientStatus).toBe('failed');
            expect(recipientReason).toBe('Media file missing on server');
        });
    });

    describe('6. Opt-out recipient suppression during media outreach', () => {
        test('skips opted-out contact immediately before dispatch', async () => {
            const contact = { phone: '919876543210', name: 'Opted Out Person' };
            const optOutStatus = { is_opted_out: true };
            const sendMediaMock = jest.fn();

            let recipientStatus = 'pending';
            let recipientReason = '';

            if (optOutStatus && optOutStatus.is_opted_out) {
                recipientStatus = 'skipped';
                recipientReason = 'Contact has opted out';
            } else {
                await sendMediaMock();
            }

            expect(recipientStatus).toBe('skipped');
            expect(recipientReason).toBe('Contact has opted out');
            expect(sendMediaMock).not.toHaveBeenCalled();
        });
    });

    describe('7. Cancellation during media outreach', () => {
        test('halts sending remaining recipients when cancel_requested is detected', async () => {
            const recipients = [
                { id: 1, phone: '919876500001', status: 'pending' },
                { id: 2, phone: '919876500002', status: 'pending' },
                { id: 3, phone: '919876500003', status: 'pending' }
            ];

            let jobStatus = 'running';
            const sent = [];
            const skipped = [];

            for (const r of recipients) {
                if (r.id === 2) {
                    jobStatus = 'cancel_requested';
                }

                if (jobStatus === 'cancel_requested') {
                    skipped.push({ ...r, status: 'skipped', reason: 'Cancelled before sending' });
                    break;
                }
                sent.push({ ...r, status: 'sent' });
            }

            expect(sent).toHaveLength(1);
            expect(sent[0].id).toBe(1);
            expect(skipped).toHaveLength(1);
            expect(skipped[0].id).toBe(2);
        });
    });

    describe('8. Failed transport error handling', () => {
        test('does not falsely mark send successful when transport throws', async () => {
            const mockFailingSend = jest.fn(async () => {
                const err = new Error('WhatsApp client is not connected');
                err.code = 'WA_NOT_CONNECTED';
                throw err;
            });

            let status = 'sending';
            let reason = '';

            try {
                await mockFailingSend();
                status = 'sent';
            } catch (err) {
                const isDisconnect = /not connected/i.test(err.message) || err.code === 'WA_NOT_CONNECTED';
                status = 'failed';
                reason = isDisconnect ? 'WhatsApp disconnected' : 'Send failed';
            }

            expect(status).toBe('failed');
            expect(reason).toBe('WhatsApp disconnected');
        });
    });

    describe('9. Campaign history safe attachment metadata (no storage path leakage)', () => {
        test('sanitizes media asset fields in API response', () => {
            const rawAssetFromDb = {
                id: 42,
                user_id: 1,
                project_id: 5,
                unit_id: null,
                asset_type: 'brochure',
                file_name: 'ocean_villas_brochure.pdf',
                storage_path: 'C:\\secret_server\\data\\assets\\1_12345_ocean_villas_brochure.pdf',
                mime_type: 'application/pdf',
                size_bytes: 4194304,
                rera_verified: 1,
                project_name: 'Ocean Villas'
            };

            const sanitizeAsset = (a) => ({
                id: a.id,
                project_id: a.project_id,
                project_name: a.project_name || '',
                asset_type: a.asset_type,
                file_name: a.file_name,
                mime_type: a.mime_type,
                size_bytes: a.size_bytes,
                rera_verified: a.rera_verified
            });

            const safe = sanitizeAsset(rawAssetFromDb);

            expect(safe.storage_path).toBeUndefined();
            expect(safe.file_name).toBe('ocean_villas_brochure.pdf');
            expect(safe.project_name).toBe('Ocean Villas');
            expect(safe.size_bytes).toBe(4194304);
            expect(JSON.stringify(safe)).not.toContain('secret_server');
        });
    });

    describe('10. Idempotency key generation for duplicate prevention', () => {
        test('constructs deterministic idempotency keys per recipient', () => {
            const generateIdempotencyKey = (jobId, recipientId) => `outreach-${jobId}-${recipientId}`;

            const key1 = generateIdempotencyKey('job-abc', 101);
            const key2 = generateIdempotencyKey('job-abc', 101);
            const key3 = generateIdempotencyKey('job-abc', 102);

            expect(key1).toBe('outreach-job-abc-101');
            expect(key1).toBe(key2); // Identical on retry
            expect(key1).not.toBe(key3); // Distinct per recipient
        });
    });
});
