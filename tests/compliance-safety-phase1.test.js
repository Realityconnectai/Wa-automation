/**
 * tests/compliance-safety-phase1.test.js
 *
 * Phase 1: Safety, Compliance & CRM Gaps
 * 1. Opt-out enforcement (persistence, API, outreach suppression, inbound STOP/START)
 * 2. Human takeover / Pause AI (per-conversation, per-deal, duration expiration, message persistence, zero AI replies)
 * 3. CSV exports (contacts, leads, deals with tenant isolation, agent scoping, and role phone masking)
 *
 * Run with:
 *   $env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/wa_test";
 *   $env:ALLOW_DESTRUCTIVE_TESTING="true";
 *   $env:BCRYPT_ROUNDS="4";
 *   $env:DISABLE_RATE_LIMITS="true";
 *   npx jest tests/compliance-safety-phase1.test.js --forceExit
 */
'use strict';

const request = require('supertest');
const { query } = require('../src/services/db-pool');

describe('Phase 1: Safety, Compliance & CRM Gaps', () => {
    let db, app;
    let adminA, adminCookieA;
    let agentA, agentCookieA;
    let adminB, adminCookieB;

    beforeEach(async () => {
        db = await freshDatabase();
        app = createTestApp();

        // Tenant A Admin
        const resA = await signup(app, {
            email: `admin_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`,
            businessName: 'Apex Realty',
            ownerName: 'Alice Admin',
            role: 'admin'
        });
        adminA = resA.user;
        adminCookieA = resA.cookie;

        // Tenant A Agent
        const resAgent = await signup(app, {
            email: `agent_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`,
            businessName: 'Apex Realty',
            ownerName: 'Alex Agent',
            role: 'agent'
        });
        agentA = resAgent.user;
        agentCookieA = resAgent.cookie;
        await query('UPDATE users SET tenant_id = $1 WHERE id = $2', [adminA.id, agentA.id]);

        // Tenant B Admin
        const resB = await signup(app, {
            email: `admin_b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`,
            businessName: 'Beacon Properties',
            ownerName: 'Bob Admin',
            role: 'admin'
        });
        adminB = resB.user;
        adminCookieB = resB.cookie;
    });

    describe('1. Opt-Out Enforcement', () => {
        test('allows marking a contact as opted out and opted back in via API with persistence', async () => {
            const contact = await db.createContact(adminA.id, '919876543210', 'Rahul Sharma', 'VIP');
            expect(contact.is_opted_out).toBeFalsy();

            // Opt-out
            const optOutRes = await request(app)
                .post(`/api/contacts/${contact.id}/opt-out`)
                .set('Cookie', adminCookieA)
                .send({ opted_out: true, reason: 'Customer requested via phone call' });

            expect(optOutRes.status).toBe(200);
            expect(optOutRes.body.success).toBe(true);
            expect(optOutRes.body.contact.is_opted_out).toBe(true);
            expect(optOutRes.body.contact.opt_out_reason).toBe('Customer requested via phone call');

            // Verify persistence in database
            const status = await db.getContactOptOutStatus(adminA.id, '919876543210');
            expect(status.is_opted_out).toBe(true);
            expect(status.opt_out_reason).toBe('Customer requested via phone call');

            // Opt-in back
            const optInRes = await request(app)
                .post(`/api/contacts/${contact.id}/opt-out`)
                .set('Cookie', adminCookieA)
                .send({ opted_out: false });

            expect(optInRes.status).toBe(200);
            expect(optInRes.body.contact.is_opted_out).toBe(false);

            const statusAfter = await db.getContactOptOutStatus(adminA.id, '919876543210');
            expect(statusAfter.is_opted_out).toBe(false);
        });

        test('prevents tenant B from toggling opt-out of tenant A contact (tenant isolation)', async () => {
            const contactA = await db.createContact(adminA.id, '919876543210', 'Rahul Sharma', 'VIP');

            const res = await request(app)
                .post(`/api/contacts/${contactA.id}/opt-out`)
                .set('Cookie', adminCookieB)
                .send({ opted_out: true });

            expect(res.status).toBe(404);

            const status = await db.getContactOptOutStatus(adminA.id, '919876543210');
            expect(status.is_opted_out).toBe(false);
        });

        test('bulk outreach job skips opted-out contacts safely and records reason in job results', async () => {
            const outreach = require('../src/services/outreach');

            // Contact 1: opted out
            const c1 = await db.createContact(adminA.id, '919876543211', 'Opted Out User', 'Lead');
            await db.setContactOptOut(adminA.id, '919876543211', true, 'Unsubscribed');

            // Contact 2: active
            const c2 = await db.createContact(adminA.id, '919876543212', 'Active User', 'Lead');

            // Stub outreach send and sleep to prevent real WhatsApp calls and delays
            const whatsappClient = require('../src/services/whatsapp-client');
            const sentPhones = [];
            const origSendText = whatsappClient.sendText;
            const origSendTextMessage = whatsappClient.sendTextMessage;
            const stubSend = async (userId, phone, message) => {
                sentPhones.push(phone);
                return { success: true, messageId: 'msg_' + Date.now() };
            };
            whatsappClient.sendText = stubSend;
            whatsappClient.sendTextMessage = stubSend;
            if (typeof outreach.setSendMessageImplementation === 'function') {
                outreach.setSendMessageImplementation(stubSend);
            }
            if (typeof outreach.setSleepImplementation === 'function') {
                outreach.setSleepImplementation(async () => {});
            }

            try {
                const job = await outreach.createOutreachJob(adminA.id, {
                    messageTemplate: 'Hello {{name}}, check out our new project!',
                    contactIds: [c1.id, c2.id],
                    minDelaySec: 0,
                    maxDelaySec: 0
                });

                // Run job synchronously
                await outreach.runJob(job.id);

                const finishedJob = await outreach.getOutreachJob(adminA.id, job.id);
                expect(finishedJob.status).toBe('completed');
                expect(finishedJob.total_recipients).toBe(2);
                expect(finishedJob.sent_count).toBe(1);
                expect(finishedJob.failed_count).toBe(1); // skipped counts towards non-sent in schema

                const recipients = await outreach.getOutreachRecipients(adminA.id, job.id);
                const rOpted = recipients.find(r => r.phone === '919876543211');
                const rActive = recipients.find(r => r.phone === '919876543212');

                expect(rOpted.status).toBe('skipped');
                expect(rOpted.error_message).toBe('Contact has opted out');

                expect(rActive.status).toBe('sent');
                expect(sentPhones).toContain('919876543212');
                expect(sentPhones).not.toContain('919876543211');
            } finally {
                whatsappClient.sendText = origSendText;
                whatsappClient.sendTextMessage = origSendTextMessage;
                if (typeof outreach.setSendMessageImplementation === 'function') {
                    outreach.setSendMessageImplementation(null);
                }
                if (typeof outreach.setSleepImplementation === 'function') {
                    outreach.setSleepImplementation(null);
                }
            }
        });

        test('inbound STOP keyword opts out contact, cancels scheduled messages, and suppresses automated replies', async () => {
            const chatbot = require('../src/services/chatbot');
            const whatsappClient = require('../src/services/whatsapp-client');

            await db.createContact(adminA.id, '919876543215', 'Sam Opt', 'VIP');
            // Schedule a message
            const futureTime = new Date(Date.now() + 3600000).toISOString();
            await db.createScheduledMessage(adminA.id, '919876543215', 'Scheduled follow-up', futureTime);

            let sentConfirmation = null;
            const origSendText = whatsappClient.sendText;
            whatsappClient.sendText = async (userId, phone, message) => {
                sentConfirmation = { userId, phone, message };
                return { success: true, messageId: 'msg_stop' };
            };

            try {
                // Inbound STOP
                const fakeMsg = {
                    from: '919876543215@c.us',
                    body: 'STOP',
                    timestamp: Math.floor(Date.now() / 1000)
                };

                await chatbot.handleIncomingMessage(adminA.id, fakeMsg);

                // Verification: Contact is opted out
                const status = await db.getContactOptOutStatus(adminA.id, '919876543215');
                expect(status.is_opted_out).toBe(true);

                // Verification: Scheduled message was cancelled
                const scheduled = await db.getScheduledMessages(adminA.id);
                const userScheduled = scheduled.filter(s => s.phone === '919876543215');
                expect(userScheduled.every(s => s.status === 'cancelled')).toBe(true);

                // Verification: Confirmation reply sent
                expect(sentConfirmation).not.toBeNull();
                expect(sentConfirmation.message).toMatch(/unsubscribed/i);

                // Subsequent inbound message from opted-out contact receives NO automated reply
                sentConfirmation = null;
                const followMsg = {
                    from: '919876543215@c.us',
                    body: 'Are you still there?',
                    timestamp: Math.floor(Date.now() / 1000)
                };
                await chatbot.handleIncomingMessage(adminA.id, followMsg);
                expect(sentConfirmation).toBeNull(); // AI suppressed!

                // Message still persisted
                const msgs = await db.getMessagesByPhone(adminA.id, '919876543215');
                expect(msgs.some(m => m.message_text === 'Are you still there?')).toBe(true);

                // Inbound START opts contact back in
                const startMsg = {
                    from: '919876543215@c.us',
                    body: 'START',
                    timestamp: Math.floor(Date.now() / 1000)
                };
                await chatbot.handleIncomingMessage(adminA.id, startMsg);
                const statusAfterStart = await db.getContactOptOutStatus(adminA.id, '919876543215');
                expect(statusAfterStart.is_opted_out).toBe(false);
                expect(sentConfirmation.message).toMatch(/resubscribed/i);
            } finally {
                whatsappClient.sendText = origSendText;
            }
        });
    });

    describe('2. Human Takeover / Pause AI', () => {
        test('allows pausing and resuming AI for a conversation and persists across deals & contacts', async () => {
            const phone = '919876543220';
            await db.createContact(adminA.id, phone, 'Takeover Prospect');
            const deal = await db.createCrmDeal(adminA.id, { phone, contactName: 'Takeover Prospect' });

            // Pause via conversation endpoint with 60 minutes duration
            const pauseRes = await request(app)
                .post(`/api/messages/conversation/${phone}/pause-ai`)
                .set('Cookie', adminCookieA)
                .send({ paused: true, duration_minutes: 60, reason: 'Senior agent handling custom proposal' });

            expect(pauseRes.status).toBe(200);
            expect(pauseRes.body.phone).toBe(phone); // admin sees full phone
            expect(pauseRes.body.is_ai_paused).toBe(true);
            expect(pauseRes.body.ai_paused_until).toBeTruthy();

            // Agent (non-admin) call receives masked phone
            const agentPauseRes = await request(app)
                .post(`/api/messages/conversation/${phone}/pause-ai`)
                .set('Cookie', agentCookieA)
                .send({ paused: true });
            expect(agentPauseRes.status).toBe(200);
            expect(agentPauseRes.body.phone).toContain('XXXXX'); // masked for agent

            // Verify db state
            const isPaused = await db.isConversationAiPaused(adminA.id, phone);
            expect(isPaused).toBe(true);

            // Resume via deal endpoint
            const resumeRes = await request(app)
                .post(`/api/crm/deals/${deal.id}/pause-ai`)
                .set('Cookie', adminCookieA)
                .send({ paused: false });

            expect(resumeRes.status).toBe(200);
            expect(resumeRes.body.data.is_ai_paused).toBe(false);

            const isPausedAfter = await db.isConversationAiPaused(adminA.id, phone);
            expect(isPausedAfter).toBe(false);
        });

        test('pausing AI suppresses chatbot replies while saving inbound messages and activity log', async () => {
            const phone = '919876543225';
            await db.createContact(adminA.id, phone, 'Takeover Chat');
            await db.createCrmDeal(adminA.id, { phone, contactName: 'Takeover Chat' });

            // Create a chatbot rule that would normally trigger
            await db.createChatbotRule(adminA.id, 'pricing', 'contains', 'Our 2BHK starts at 75L', 10);

            // Pause AI
            await db.setConversationAiPause(adminA.id, phone, true, null, 'Agent human takeover');

            const chatbot = require('../src/services/chatbot');
            const whatsappClient = require('../src/services/whatsapp-client');
            let sentReply = null;
            const origSendText = whatsappClient.sendText;
            whatsappClient.sendText = async (userId, p, msg) => {
                sentReply = { userId, phone: p, msg };
                return { success: true, messageId: 'msg_reply' };
            };

            try {
                const incoming = {
                    from: `${phone}@c.us`,
                    body: 'Can you tell me about the pricing?',
                    timestamp: Math.floor(Date.now() / 1000)
                };

                await chatbot.handleIncomingMessage(adminA.id, incoming);

                // Automated reply MUST NOT be sent
                expect(sentReply).toBeNull();

                // Inbound message MUST be saved in database
                const msgs = await db.getMessagesByPhone(adminA.id, phone);
                expect(msgs.some(m => m.message_text === 'Can you tell me about the pricing?')).toBe(true);
            } finally {
                whatsappClient.sendText = origSendText;
            }
        });

        test('time-bound pause resumes automatically when expired', async () => {
            const phone = '919876543230';
            await db.createContact(adminA.id, phone, 'Timer Lead');
            const deal = await db.createCrmDeal(adminA.id, { phone, contactName: 'Timer Lead' });

            // Explicitly set an expired timestamp in the past
            const pastDate = new Date(Date.now() - 60000); // 1 minute ago
            await query(
                `UPDATE crm_deals SET is_ai_paused = true, ai_paused_until = $1 WHERE id = $2`,
                [pastDate, deal.id]
            );

            // Should be evaluated as NOT paused because duration expired
            const isPaused = await db.isConversationAiPaused(adminA.id, phone);
            expect(isPaused).toBe(false);
        });
    });

    describe('3. CSV Exports', () => {
        test('contacts export enforces tenant isolation, phone masking, and spreadsheet sanitization', async () => {
            // Setup contacts for Tenant A and Tenant B
            await db.createContact(adminA.id, '919876543241', '=1+1 Dangerous', 'Formula');
            await db.createContact(adminA.id, '919876543242', 'Normal Contact', 'VIP');
            await db.createContact(adminB.id, '919876543249', 'Tenant B Person', 'Other');

            // Admin A export (unmasked phone, isolated to tenant A)
            const adminExport = await request(app)
                .get('/api/contacts/export')
                .set('Cookie', adminCookieA);

            expect(adminExport.status).toBe(200);
            expect(adminExport.headers['content-type']).toMatch(/text\/csv/);
            expect(adminExport.text).toContain('919876543241');
            expect(adminExport.text).toContain('919876543242');
            expect(adminExport.text).not.toContain('919876543249'); // Tenant isolation!
            // Spreadsheet formula protection: leading '=' sanitized to "'=1+1 Dangerous"
            expect(adminExport.text).toContain("'=1+1 Dangerous");

            // Agent A export (masked phone)
            const agentExport = await request(app)
                .get('/api/contacts/export')
                .set('Cookie', agentCookieA);

            expect(agentExport.status).toBe(200);
            expect(agentExport.text).not.toContain('919876543241'); // Unmasked phone must NOT appear
            expect(agentExport.text).toMatch(/\+91 98765 XXXXX/); // Masked format!
        });

        test('leads export returns CSV with tenant isolation and role-based phone masking', async () => {
            await db.createContact(adminA.id, '919876543250', 'Lead Alice');
            await db.saveLeadAnalysis(adminA.id, '919876543250', {
                intent: 'buy',
                budget: '85 Lakhs',
                locality: 'Whitefield',
                timeline: 'Immediate',
                priority: 'high',
                temperature: 'HOT',
                interest_level: 'interested',
                summary: 'Looking for 3BHK ready to move in Whitefield'
            });

            // Tenant B lead
            await db.createContact(adminB.id, '919876543259', 'Lead Bob');
            await db.saveLeadAnalysis(adminB.id, '919876543259', {
                intent: 'rent',
                summary: 'Tenant B secret lead'
            });

            // Admin A export
            const adminExport = await request(app)
                .get('/api/leads/export')
                .set('Cookie', adminCookieA);

            expect(adminExport.status).toBe(200);
            expect(adminExport.text).toContain('Whitefield');
            expect(adminExport.text).toContain('919876543250');
            expect(adminExport.text).not.toContain('Tenant B secret lead');

            // Agent A export
            const agentExport = await request(app)
                .get('/api/leads/export')
                .set('Cookie', agentCookieA);

            expect(agentExport.status).toBe(200);
            expect(agentExport.text).not.toContain('919876543250');
            expect(agentExport.text).toMatch(/\+91 98765 XXXXX/);
        });

        test('deals export restricts agents to their assigned deals and masks phone numbers', async () => {
            const leadAssignment = require('../src/services/lead-assignment');

            // Create agent profile linked to user agentA
            const agentProfile = await leadAssignment.createAgent(adminA.id, {
                name: 'Alex Agent',
                email: agentA.email,
                phone: '919876543299',
                user_id: agentA.id,
                role: 'agent',
                routing_status: 'available'
            });

            // Deal 1: Assigned to agentProfile
            const deal1 = await db.createCrmDeal(adminA.id, {
                phone: '919876543261',
                contactName: 'Assigned Deal',
                dealValue: 12000000,
                stage: 'site_visit'
            });
            await leadAssignment.assignLead(adminA.id, deal1.id, agentProfile.id, 'Direct assignment');

            // Deal 2: Unassigned / Admin deal
            const deal2 = await db.createCrmDeal(adminA.id, {
                phone: '919876543262',
                contactName: 'Unassigned Admin Deal',
                dealValue: 5000000,
                stage: 'new'
            });
            await query('UPDATE crm_deals SET assigned_agent_id = NULL WHERE id = $1', [deal2.id]);

            // Admin A export gets both deals unmasked
            const adminExport = await request(app)
                .get('/api/crm/deals/export')
                .set('Cookie', adminCookieA);

            expect(adminExport.status).toBe(200);
            expect(adminExport.text).toContain('Assigned Deal');
            expect(adminExport.text).toContain('Unassigned Admin Deal');
            expect(adminExport.text).toContain('919876543261');
            expect(adminExport.text).toContain('919876543262');

            // Agent A export gets ONLY assigned deal, and phone is masked
            const agentExport = await request(app)
                .get('/api/crm/deals/export')
                .set('Cookie', agentCookieA);

            expect(agentExport.status).toBe(200);
            expect(agentExport.text).toContain('Assigned Deal');
            expect(agentExport.text).not.toContain('Unassigned Admin Deal'); // Agent scoping!
            expect(agentExport.text).not.toContain('919876543261'); // Unmasked phone must not be visible
            expect(agentExport.text).toMatch(/\+91 98765 XXXXX/);
        });
    });
});
