import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL not set");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function testAnswerFeedback() {
  console.log("\n========== TEST 1: Answer Feedback Insert ==========");
  try {
    const result = await sql`
      INSERT INTO answer_feedback
        (ui_block_id, user_prompt, is_correct, feedback_text, org_id, project_id, user_id, answer_snapshot)
      VALUES
        ('block-123', 'What is 2+2?', true, 'Correct answer', 'org-1', 'proj-1', 'user-1', '{"text": "The answer is 4"}'::jsonb)
      RETURNING *;
    `;
    console.log("✅ INSERT SUCCESS");
    console.log("Row inserted:", JSON.stringify(result[0], null, 2));
    return result[0];
  } catch (e) {
    console.error("❌ INSERT FAILED:", e.message);
    throw e;
  }
}

async function testAnswerFeedbackSecondInsert() {
  console.log("\n========== TEST 2: Answer Feedback Second Insert (different block) ==========");
  try {
    // Insert different block - central table just mirrors, no upsert needed
    const result = await sql`
      INSERT INTO answer_feedback
        (ui_block_id, user_prompt, is_correct, feedback_text, org_id, project_id, user_id)
      VALUES
        ('block-456', 'What is the capital of France?', true, 'Paris is correct', 'org-1', 'proj-1', 'user-1')
      RETURNING *;
    `;
    console.log("✅ INSERT SUCCESS (central table mirrors local inserts)");
    console.log("Row inserted:", JSON.stringify(result[0], null, 2));
  } catch (e) {
    console.error("❌ INSERT FAILED:", e.message);
    throw e;
  }
}

async function testProductFeedback() {
  console.log("\n========== TEST 3: Product Feedback Insert ==========");
  try {
    const result = await sql`
      INSERT INTO product_feedback
        (org_id, user_id, category, message, page_context)
      VALUES
        ('org-1', 'user-1', 'idea', 'Great product, love the UI!', '/chat')
      RETURNING *;
    `;
    console.log("✅ INSERT SUCCESS");
    console.log("Row inserted:", JSON.stringify(result[0], null, 2));
    return result[0];
  } catch (e) {
    console.error("❌ INSERT FAILED:", e.message);
    throw e;
  }
}

async function testProductFeedback2() {
  console.log("\n========== TEST 4: Product Feedback - Bug Report ==========");
  try {
    const result = await sql`
      INSERT INTO product_feedback
        (org_id, user_id, category, message, page_context)
      VALUES
        ('org-2', 'user-2', 'bug', 'Chat crashes when submitting long messages', '/chat/session-123')
      RETURNING *;
    `;
    console.log("✅ INSERT SUCCESS");
    console.log("Row inserted:", JSON.stringify(result[0], null, 2));
  } catch (e) {
    console.error("❌ INSERT FAILED:", e.message);
    throw e;
  }
}

async function testQueryAnswerFeedback() {
  console.log("\n========== TEST 5: Query Answer Feedback ==========");
  try {
    const result = await sql`SELECT * FROM answer_feedback ORDER BY created_at DESC LIMIT 10`;
    console.log("✅ QUERY SUCCESS");
    console.log(`Found ${result.length} row(s):`);
    result.forEach((row, i) => {
      console.log(`\n  Row ${i + 1}:`);
      console.log(`    id: ${row.id}`);
      console.log(`    ui_block_id: ${row.ui_block_id}`);
      console.log(`    is_correct: ${row.is_correct}`);
      console.log(`    feedback_text: ${row.feedback_text}`);
      console.log(`    user_id: ${row.user_id}`);
      console.log(`    org_id: ${row.org_id}`);
      console.log(`    created_at: ${row.created_at}`);
    });
  } catch (e) {
    console.error("❌ QUERY FAILED:", e.message);
    throw e;
  }
}

async function testQueryProductFeedback() {
  console.log("\n========== TEST 6: Query Product Feedback ==========");
  try {
    const result = await sql`SELECT * FROM product_feedback ORDER BY created_at DESC LIMIT 10`;
    console.log("✅ QUERY SUCCESS");
    console.log(`Found ${result.length} row(s):`);
    result.forEach((row, i) => {
      console.log(`\n  Row ${i + 1}:`);
      console.log(`    id: ${row.id}`);
      console.log(`    message: ${row.message}`);
      console.log(`    category: ${row.category}`);
      console.log(`    page_context: ${row.page_context}`);
      console.log(`    org_id: ${row.org_id}`);
      console.log(`    user_id: ${row.user_id}`);
      console.log(`    created_at: ${row.created_at}`);
    });
  } catch (e) {
    console.error("❌ QUERY FAILED:", e.message);
    throw e;
  }
}

async function testIndexes() {
  console.log("\n========== TEST 7: Verify Indexes Exist ==========");
  try {
    const indexes = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('answer_feedback', 'product_feedback')
      ORDER BY tablename, indexname;
    `;
    console.log("✅ INDEXES FOUND:");
    indexes.forEach(idx => {
      console.log(`  - ${idx.indexname}`);
    });
  } catch (e) {
    console.error("❌ INDEX CHECK FAILED:", e.message);
    throw e;
  }
}

async function main() {
  console.log("🧪 Testing Feedback Tables\n");
  console.log("DATABASE_URL:", DATABASE_URL.substring(0, 50) + "...\n");

  try {
    await testAnswerFeedback();
    await testAnswerFeedbackSecondInsert();
    await testProductFeedback();
    await testProductFeedback2();
    await testQueryAnswerFeedback();
    await testQueryProductFeedback();
    await testIndexes();
    console.log("\n" + "=".repeat(60));
    console.log("✅ ALL TESTS PASSED!");
    console.log("=".repeat(60));
  } catch (e) {
    console.error("\n❌ TESTS FAILED");
    process.exit(1);
  }
}

main().catch(console.error);
