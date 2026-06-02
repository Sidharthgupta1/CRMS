'use strict';

/**
 * Motherson CRMS — Database Seed Script
 * Run AFTER migrate.js:  node scripts/seed.js
 *
 * Seeds: companies, services, users, groups, group members,
 *        demo releases, tasks, comments, audit entries.
 */

require('dotenv').config();

const oracledb = require('oracledb');
const bcrypt   = require('bcryptjs');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

// ── Seed data ─────────────────────────────────────────────────────────
const COMPANIES = ['MSSL', 'Motherson Sumi', 'Motherson Innovations', 'Motherson Technology'];
const SERVICES  = ['Oracle', 'SAP', 'Salesforce', 'ServiceNow', 'Workday'];

const USERS = [
  { initials: 'SG', fullName: 'Sandeep Gupta',  role: 'admin', password: 'admin123' },
  { initials: 'RK', fullName: 'Rohit Kumar',     role: 'user',  password: 'pass123'  },
  { initials: 'PM', fullName: 'Priya Mehta',     role: 'user',  password: 'pass123'  },
  { initials: 'AV', fullName: 'Amit Verma',      role: 'user',  password: 'pass123'  },
];

const GROUPS = [
  { name: 'MSSL-Oracle-Functional', description: 'Oracle EBS Functional team', members: ['SG','PM'] },
  { name: 'MSSL-Oracle-Technical',  description: 'Oracle EBS Technical team',  members: ['RK','AV'] },
  { name: 'MSSL-SAP-Basis',         description: 'SAP Basis & Infrastructure', members: ['PM']      },
];

// ── Runner ────────────────────────────────────────────────────────────
async function seed() {
  let conn;
  try {
    conn = await oracledb.getConnection({
      user:             process.env.DB_USER,
      password:         process.env.DB_PASSWORD,
      connectionString: process.env.DB_CONNECTION_STRING,
    });

    console.log(`\n🔌  Connected to Oracle: ${process.env.DB_CONNECTION_STRING}`);
    console.log('🌱  Seeding reference data...\n');

    // ── Companies ─────────────────────────────────────────────────────
    for (const name of COMPANIES) {
      try {
        await conn.execute(
          `INSERT INTO crms_companies (company_name) VALUES (:name)`, { name }
        );
        console.log(`  ✅ Company: ${name}`);
      } catch (e) {
        if (e.errorNum === 1) console.log(`  ⏭️  Company: ${name} (exists)`);
        else throw e;
      }
    }

    // ── Services ──────────────────────────────────────────────────────
    for (const name of SERVICES) {
      try {
        await conn.execute(
          `INSERT INTO crms_services (service_name) VALUES (:name)`, { name }
        );
        console.log(`  ✅ Service: ${name}`);
      } catch (e) {
        if (e.errorNum === 1) console.log(`  ⏭️  Service: ${name} (exists)`);
        else throw e;
      }
    }

    // ── Users ─────────────────────────────────────────────────────────
    const userIdMap = {}; // initials → user_id
    for (const u of USERS) {
      try {
        const hash = await bcrypt.hash(u.password, 12);
        await conn.execute(
          `INSERT INTO crms_users (initials, full_name, role, password_hash)
           VALUES (UPPER(:initials), :fullName, :role, :hash)`,
          { initials: u.initials, fullName: u.fullName, role: u.role, hash }
        );
        const row = await conn.execute(
          `SELECT user_id FROM crms_users WHERE initials = UPPER(:i)`,
          { i: u.initials }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        userIdMap[u.initials] = row.rows[0].USER_ID;
        console.log(`  ✅ User: ${u.fullName} (${u.role})`);
      } catch (e) {
        if (e.errorNum === 1) {
          const row = await conn.execute(
            `SELECT user_id FROM crms_users WHERE initials = UPPER(:i)`,
            { i: u.initials }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );
          userIdMap[u.initials] = row.rows[0].USER_ID;
          console.log(`  ⏭️  User: ${u.fullName} (exists)`);
        } else throw e;
      }
    }

    // ── Groups ────────────────────────────────────────────────────────
    const groupIdMap = {}; // name → group_id
    for (const g of GROUPS) {
      try {
        await conn.execute(
          `INSERT INTO crms_assignment_groups (group_name, description)
           VALUES (:name, :desc)`,
          { name: g.name, desc: g.description }
        );
        const row = await conn.execute(
          `SELECT group_id FROM crms_assignment_groups WHERE group_name = :name`,
          { name: g.name }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        groupIdMap[g.name] = row.rows[0].GROUP_ID;
        console.log(`  ✅ Group: ${g.name}`);
      } catch (e) {
        if (e.errorNum === 1) {
          const row = await conn.execute(
            `SELECT group_id FROM crms_assignment_groups WHERE group_name = :name`,
            { name: g.name }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );
          groupIdMap[g.name] = row.rows[0].GROUP_ID;
          console.log(`  ⏭️  Group: ${g.name} (exists)`);
        } else throw e;
      }

      // Members
      for (const initials of g.members) {
        const uid = userIdMap[initials];
        const gid = groupIdMap[g.name];
        if (!uid || !gid) continue;
        try {
          await conn.execute(
            `INSERT INTO crms_group_members (group_id, user_id) VALUES (:gid, :uid)`,
            { gid, uid }
          );
          console.log(`     👤 Member: ${initials} → ${g.name}`);
        } catch (e) {
          if (e.errorNum === 1) console.log(`     ⏭️  Member: ${initials} already in ${g.name}`);
          else throw e;
        }
      }
    }

    // ── Demo Releases ─────────────────────────────────────────────────
    console.log('\n🗂️   Seeding demo releases...\n');

    const adminId = userIdMap['SG'];
    const pmId    = userIdMap['PM'];
    const rkId    = userIdMap['RK'];
    const avId    = userIdMap['AV'];
    const fgId    = groupIdMap['MSSL-Oracle-Functional'];
    const tgId    = groupIdMap['MSSL-Oracle-Technical'];

    const demoReleases = [
      {
        num: 'RLSE0011972', state: 'BRD Phase', priority: '3',
        title: 'IDACS Phase 2 Pick Release Integration',
        summary: 'Review and integrate the IDACS Phase 2 pick release functionality into Oracle EBS.',
        company: 'MSSL', service: 'Oracle', startDate: '2025-04-01', endDate: '2025-06-30',
        requestedBy: adminId, agId: fgId, assignedTo: pmId,
        history: [
          { action: 'Created',      from: null,    to: 'Draft',     by: adminId },
          { action: 'State Change', from: 'Draft', to: 'BRD Phase', by: adminId },
        ],
      },
      {
        num: 'RLSE0011973', state: 'Development Phase', priority: '1',
        title: 'Oracle Financials Year-End Close Automation',
        summary: 'Automate and streamline the Oracle financials year-end closing process for MSSL.',
        company: 'MSSL', service: 'Oracle', startDate: '2025-03-01', endDate: '2025-05-31',
        requestedBy: rkId, agId: tgId, assignedTo: avId,
        history: [
          { action: 'Created',      from: null,        to: 'Draft',              by: rkId },
          { action: 'State Change', from: 'Draft',     to: 'BRD Phase',          by: rkId },
          { action: 'State Change', from: 'BRD Phase', to: 'FSD Phase',          by: rkId },
          { action: 'State Change', from: 'FSD Phase', to: 'Awaiting approval',  by: rkId },
          { action: 'State Change', from: 'Awaiting approval', to: 'Development Phase', by: adminId },
        ],
      },
      {
        num: 'RLSE0011974', state: 'Testing/QA', priority: '2',
        title: 'SAP HR Integration with Oracle HCM',
        summary: 'Integrate SAP HR module data feeds with Oracle HCM for unified employee management.',
        company: 'MSSL', service: 'SAP', startDate: '2025-02-15', endDate: '2025-04-30',
        requestedBy: pmId, agId: fgId, assignedTo: adminId,
        history: [
          { action: 'Created', from: null, to: 'Draft', by: pmId },
        ],
      },
    ];

    const releaseIdMap = {};

    for (const rel of demoReleases) {
      try {
        await conn.execute(
          `INSERT INTO crms_releases
             (release_number, state, priority, title, summary, company, service,
              planned_start_date, target_end_date, requested_by,
              assignment_group_id, assigned_to_user_id)
           VALUES
             (:num, :state, :priority, :title, :summary, :company, :service,
              TO_DATE(:startDate,'YYYY-MM-DD'), TO_DATE(:endDate,'YYYY-MM-DD'),
              :requestedBy, :agId, :assignedTo)`,
          {
            num: rel.num, state: rel.state, priority: rel.priority,
            title: rel.title, summary: rel.summary,
            company: rel.company, service: rel.service,
            startDate: rel.startDate, endDate: rel.endDate,
            requestedBy: rel.requestedBy, agId: rel.agId, assignedTo: rel.assignedTo,
          }
        );
        const row = await conn.execute(
          `SELECT release_id FROM crms_releases WHERE release_number = :num`,
          { num: rel.num }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const releaseId = row.rows[0].RELEASE_ID;
        releaseIdMap[rel.num] = releaseId;

        // History
        for (const h of rel.history) {
          await conn.execute(
            `INSERT INTO crms_release_history (release_id, action, from_state, to_state, changed_by)
             VALUES (:rid, :action, :from, :to, :by)`,
            { rid: releaseId, action: h.action, from: h.from || null, to: h.to, by: h.by }
          );
        }

        // Audit entry
        await conn.execute(
          `INSERT INTO crms_audit (action, performed_by, cr_number, details)
           VALUES ('Created', :uid, :num, :num || ' "' || :title || '" seeded')`,
          { uid: rel.requestedBy, num: rel.num, title: rel.title }
        );

        console.log(`  ✅ Release: ${rel.num} — ${rel.title}`);
      } catch (e) {
        if (e.errorNum === 1) console.log(`  ⏭️  Release: ${rel.num} (exists)`);
        else throw e;
      }
    }

    // ── Demo Tasks ─────────────────────────────────────────────────────
    console.log('\n📋  Seeding demo tasks...\n');

    const demoTasks = [
      {
        num: 'RTSK0015933', releaseNum: 'RLSE0011972', phase: 'BRD', type: 'BRD Task',
        desc: 'Review IDACS Phase 2 business requirements document',
        agId: fgId, assignedTo: pmId, createdBy: adminId,
      },
      {
        num: 'RTSK0015934', releaseNum: 'RLSE0011973', phase: 'Dev', type: 'Development Task',
        desc: 'Build year-end GL closing automation scripts',
        agId: tgId, assignedTo: avId, createdBy: rkId,
      },
      {
        num: 'RTSK0015935', releaseNum: 'RLSE0011973', phase: 'Dev', type: 'Development Task',
        desc: 'Create reconciliation report for period-end balances',
        agId: tgId, assignedTo: rkId, createdBy: rkId,
      },
      {
        num: 'RTSK0015936', releaseNum: 'RLSE0011974', phase: 'BRD', type: 'BRD Task',
        desc: 'Map SAP HR fields to Oracle HCM attributes',
        agId: fgId, assignedTo: adminId, createdBy: pmId,
      },
    ];

    for (const task of demoTasks) {
      const releaseId = releaseIdMap[task.releaseNum];
      if (!releaseId) { console.log(`  ⚠️  Skipping task ${task.num} — release not found`); continue; }
      try {
        await conn.execute(
          `INSERT INTO crms_tasks
             (task_number, release_id, phase, task_type, state,
              short_description, assignment_group_id, assigned_to_user_id, created_by)
           VALUES
             (:num, :rid, :phase, :type, 'Open', :desc, :agId, :assignedTo, :createdBy)`,
          {
            num: task.num, rid: releaseId,
            phase: task.phase, type: task.type,
            desc: task.desc, agId: task.agId,
            assignedTo: task.assignedTo, createdBy: task.createdBy,
          }
        );
        await conn.execute(
          `INSERT INTO crms_audit (action, performed_by, cr_number, details)
           VALUES ('Task Created', :uid, :crNum, :taskNum || ' (' || :type || ') seeded')`,
          { uid: task.createdBy, crNum: task.releaseNum, taskNum: task.num, type: task.type }
        );
        console.log(`  ✅ Task: ${task.num} [${task.phase}]`);
      } catch (e) {
        if (e.errorNum === 1) console.log(`  ⏭️  Task: ${task.num} (exists)`);
        else throw e;
      }
    }

    // ── Demo Comments ─────────────────────────────────────────────────
    console.log('\n💬  Seeding demo comments...\n');

    const rel1Id = releaseIdMap['RLSE0011972'];
    if (rel1Id) {
      const comments = [
        { text: 'BRD review meeting scheduled for next week. Please prepare the as-is process maps.', by: adminId },
        { text: 'As-is maps uploaded to SharePoint. Review and update the gap analysis section.', by: pmId },
      ];
      for (const c of comments) {
        await conn.execute(
          `INSERT INTO crms_comments (release_id, comment_text, created_by) VALUES (:rid, :text, :uid)`,
          { rid: rel1Id, text: c.text, uid: c.by }
        );
        console.log(`  ✅ Comment on RLSE0011972`);
      }
    }

    // ── System audit entry ────────────────────────────────────────────
    await conn.execute(
      `INSERT INTO crms_audit (action, performed_by, cr_number, details)
       VALUES ('System Start', :uid, '--', 'CR Management System initialized — seed complete')`,
      { uid: adminId }
    );

    await conn.commit();

    console.log('\n═══════════════════════════════════════════');
    console.log('  🎉  Seed complete! Database is ready.');
    console.log('\n  Demo login credentials:');
    console.log('  ┌──────────────────┬──────────┬───────────┬──────────┐');
    console.log('  │ User             │ Initials │ Role      │ Password │');
    console.log('  ├──────────────────┼──────────┼───────────┼──────────┤');
    console.log('  │ Sandeep Gupta    │ SG       │ admin     │ admin123 │');
    console.log('  │ Rohit Kumar      │ RK       │ user      │ pass123  │');
    console.log('  │ Priya Mehta      │ PM       │ user      │ pass123  │');
    console.log('  │ Amit Verma       │ AV       │ user      │ pass123  │');
    console.log('  └──────────────────┴──────────┴───────────┴──────────┘');
    console.log('═══════════════════════════════════════════\n');

  } catch (err) {
    console.error('\n💥 Seed failed:', err.message);
    if (conn) await conn.rollback();
    process.exit(1);
  } finally {
    if (conn) await conn.close();
  }
}

seed();
