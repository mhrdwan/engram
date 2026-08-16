#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveConfig } from './config.js'
import { openDb, migrateLegacyDb } from './store/db.js'
import { getRecentContext } from './store/memory-store.js'
import { warmupEmbedder } from './store/embedder.js'
import { createServer } from './server.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function parseArgs(): { project?: string; command: 'serve' | 'init' | 'load' } {
  const args = process.argv.slice(2)
  const first = args[0]
  const command = first === 'init' ? 'init' : first === 'load' ? 'load' : 'serve'
  const idx = args.indexOf('--project')
  return { project: idx !== -1 ? args[idx + 1] : undefined, command }
}

/** Buka DB unified + jalankan migrasi legacy sekali. Dipakai serve & load. */
function bootStore(projectArg?: string) {
  const config = resolveConfig(projectArg)
  openDb(config.dbPath)
  try {
    migrateLegacyDb(config.legacyDbPath, config.projectKey)
  } catch (err) {
    console.error('[engram] migration error (non-fatal):', errMsg(err))
  }
  return config
}

/**
 * Subcommand `load`: cetak konteks terbaru ke stdout.
 * Dipakai sebagai Claude Code SessionStart hook supaya memory ke-inject
 * otomatis di awal sesi — tanpa bergantung pada model memanggil tool sendiri
 * (dan jauh lebih hemat token daripada re-scan project).
 */
function runLoad(projectArg?: string) {
  const config = bootStore(projectArg)
  const ctx = getRecentContext(config.projectKey)
  if (ctx) {
    process.stdout.write(`# Engram memory — ${config.projectName}\n\n${ctx}\n`)
  }
  process.exit(0)
}

async function runInit() {
  console.log('🧠 Initializing Engram globally...')

  // Path absolut ke entrypoint ini + node yang sedang berjalan → registrasi
  // yang stabil (tidak bergantung PATH/nvm/registry seperti `npx -y`).
  const indexPath = fileURLToPath(import.meta.url)
  const nodePath = process.execPath

  // 1. Install Skill for Claude/Opencode
  const skillDir = path.join(os.homedir(), '.claude', 'skills', 'engram')
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true })
  }
  const skillPath = path.join(skillDir, 'SKILL.md')
  const skillContent = `<skill_content name="engram">
# Skill: Engram Persistent Memory

You are equipped with Engram, a persistent memory system (via MCP).

## Core Rules:
1. **Always load context first**: If this is a new session or you are asked to continue work, call \`context_status\` with \`{ "action": "load" }\` to get the latest project context.
2. **Remember decisions & bugs**: Whenever you make a technical decision, choose a framework, fix a complex bug, or learn a user preference, call \`remember\`.
3. **Session Summary**: At the end of a long task, call \`session_summary\` to leave a trail for your future self.
4. **Recall when stuck**: If you forget how something was configured, use \`recall\` to search your memory.

Do not re-analyze the whole project if Engram already knows the stack. Use your memory!
</skill_content>`
  fs.writeFileSync(skillPath, skillContent, 'utf8')
  console.log('✅ Skill installed at:', skillPath)

  const serverEntry = { command: nodePath, args: [indexPath, '--project', '.'] }

  // 2. Patch opencode.json
  const opencodePath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  if (fs.existsSync(opencodePath)) {
    try {
      const config = JSON.parse(fs.readFileSync(opencodePath, 'utf8'))
      config.mcp = config.mcp || {}
      config.mcp.engram = { type: 'local', ...serverEntry }
      fs.writeFileSync(opencodePath, JSON.stringify(config, null, 2), 'utf8')
      console.log('✅ Registered MCP server in opencode.json')
    } catch (e) {
      console.error('❌ Failed to patch opencode.json:', e)
    }
  }

  // 3. Patch Claude Desktop config
  const claudePath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  if (fs.existsSync(claudePath)) {
    try {
      const config = JSON.parse(fs.readFileSync(claudePath, 'utf8'))
      config.mcpServers = config.mcpServers || {}
      config.mcpServers.engram = { ...serverEntry }
      fs.writeFileSync(claudePath, JSON.stringify(config, null, 2), 'utf8')
      console.log('✅ Registered MCP server in claude_desktop_config.json')
    } catch (e) {
      console.error('❌ Failed to patch claude_desktop_config.json:', e)
    }
  }

  // 4. Patch Claude CLI config (~/.claude.json)
  const claudeCliPath = path.join(os.homedir(), '.claude.json')
  if (fs.existsSync(claudeCliPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(claudeCliPath, 'utf8'))
      config.mcpServers = config.mcpServers || {}
      config.mcpServers.engram = { ...serverEntry }
      fs.writeFileSync(claudeCliPath, JSON.stringify(config, null, 2), 'utf8')
      console.log('✅ Registered MCP server in ~/.claude.json (Claude CLI)')
    } catch (e) {
      console.error('❌ Failed to patch ~/.claude.json:', e)
    }
  }

  // 5. Pasang SessionStart hook di ~/.claude/settings.json → auto-inject memory
  //    di awal tiap sesi (deterministik, hemat token, tidak bergantung model).
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
    const settings = fs.existsSync(settingsPath)
      ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      : {}
    settings.hooks = settings.hooks || {}
    const loadCmd = `${JSON.stringify(nodePath)} ${JSON.stringify(indexPath)} load --project .`

    type HookEntry = { hooks?: Array<{ type?: string; command?: string }> }
    const sessionStart: HookEntry[] = Array.isArray(settings.hooks.SessionStart)
      ? settings.hooks.SessionStart
      : []

    // Identifikasi hook milik Engram secara PRESISI (indexPath + " load"), bukan
    // sekadar substring "engram" yang bisa mengenai hook lain. Selalu tulis ulang
    // supaya path node yang basi (mis. ganti versi nvm) ikut ter-refresh.
    const isOurs = (h: HookEntry) =>
      Array.isArray(h?.hooks) &&
      h.hooks.some(x => typeof x?.command === 'string' && x.command.includes(indexPath) && x.command.includes(' load'))

    const others = sessionStart.filter(h => !isOurs(h))
    const hadOurs = others.length !== sessionStart.length
    others.push({ hooks: [{ type: 'command', command: loadCmd }] })
    settings.hooks.SessionStart = others
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
    console.log(`✅ ${hadOurs ? 'Refreshed' : 'Installed'} SessionStart hook (auto-load memory) in settings.json`)
  } catch (e) {
    console.error('❌ Failed to install SessionStart hook:', e)
  }

  console.log('\n🎉 Engram global initialization complete!')
  console.log('Make sure you have installed it globally: npm install -g .')
  process.exit(0)
}

async function main() {
  const { project: projectArg, command } = parseArgs()

  if (command === 'init') {
    await runInit()
    return
  }

  if (command === 'load') {
    runLoad(projectArg)
    return
  }

  const config = bootStore(projectArg)

  // Hangatkan model embedding di background supaya call pertama tidak lambat.
  warmupEmbedder()

  const server = createServer(config.projectKey)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(`engram-mcp running — project: ${config.projectName} (key: ${config.projectKey})`)
  console.error(`  DB: ${config.dbPath}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
