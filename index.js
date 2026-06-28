require('dotenv').config()

let currentQR = null
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { createClient } = require('@supabase/supabase-js')
const http = require('http')

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
)

// Auth state persistido no Supabase
async function useSupabaseAuthState() {
    const writeData = async (data, id) => {
        await supabase.from('baileys_sessions').upsert({
            id,
            data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)),
            updated_at: new Date().toISOString()
        })
    }

    const readData = async (id) => {
        const { data } = await supabase.from('baileys_sessions').select('data').eq('id', id).single()
        if (!data) return null
        return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver)
    }

    const removeData = async (id) => {
        await supabase.from('baileys_sessions').delete().eq('id', id)
    }

    const creds = await readData('creds') || initAuthCreds()

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`)
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value)
                        }
                        data[id] = value
                    }))
                    return data
                },
                set: async (data) => {
                    const tasks = []
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id]
                            const key = `${category}-${id}`
                            tasks.push(value ? writeData(value, key) : removeData(key))
                        }
                    }
                    await Promise.all(tasks)
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    }
}

const ADMINS = [
    '138285095608537@lid', // Henry
    '559885003226@s.whatsapp.net', // Henry
    // '559885303729@s.whatsapp.net', // Patrick gay
    // '237121000452280@lid', // Patrick gay
]

const ALLOWED_USERS = [
    ...ADMINS,
]

let sock = null

async function connectToWhatsApp() {
    const { state, saveCreds } = await useSupabaseAuthState()

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        getMessage: async () => undefined,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            currentQR = qr
            console.log('QR code disponível em /qr')
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Conexão fechada. Reconectando:', shouldReconnect)
            if (shouldReconnect) connectToWhatsApp()
        }

        if (connection === 'open') {
            currentQR = null
            console.log('WhatsApp conectado!')
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            if (!msg.message) continue

            const sender = msg.key.remoteJid

            if (sender.endsWith('@g.us')) continue
            if (sender.endsWith('@newsletter')) continue
            if (sender.endsWith('@broadcast')) continue

            const myLid = sock.authState.creds.me?.lid?.split(':')[0] + '@lid'
            const myJid = sock.authState.creds.me?.id?.split(':')[0] + '@s.whatsapp.net'
            const isSelfMessage = msg.key.fromMe && (sender === myLid || sender === myJid)
            const isAllowedUser = !msg.key.fromMe && ALLOWED_USERS.includes(sender)

            if (!isSelfMessage && !isAllowedUser) continue

            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
            if (!text) continue

            console.log(`Mensagem de ${sender}: ${text}`)
            await handleMessage(sender, text.trim())
        }
    })
}

async function getSession(sender) {
    const result = await supabase.from('sessions').select('data').eq('sender', sender)
    if (result.data && result.data.length > 0) return result.data[0].data
    return null
}

async function setSession(sender, data) {
    await supabase.from('sessions').upsert({
        sender,
        data,
        updated_at: new Date().toISOString()
    })
}

async function deleteSession(sender) {
    await supabase.from('sessions').delete().eq('sender', sender)
}

async function sendMessage(to, text) {
    await sock.sendMessage(to, { text })
}

async function handleMessage(sender, text) {
    const textLower = text.toLowerCase()

    if (textLower === 'bot lembrete' || textLower === 'menu') {
        await sendMessage(sender,
            '🤖 *Bot de Lembretes*\n\n' +
            'O que você quer fazer?\n\n' +
            '1 - Criar lembrete\n' +
            '2 - Listar lembretes\n' +
            '3 - Cancelar lembrete'
        )
        await setSession(sender, { step: 'menu' })
        return
    }

    const session = await getSession(sender)

    if (session?.step === 'menu') {
        if (text === '1') {
            await deleteSession(sender)
            await setSession(sender, { step: 'contact' })
            await sendMessage(sender, 'Qual o número do contato? (ex: 5598912345678)')
            return
        }
        if (text === '2') {
            await deleteSession(sender)
            await listReminders(sender)
            return
        }
        if (text === '3') {
            await deleteSession(sender)
            await setSession(sender, { step: 'cancel' })
            await listReminders(sender)
            await sendMessage(sender, 'Digite o ID do lembrete que quer cancelar:')
            return
        }
        await sendMessage(sender, 'Manda só o número: 1, 2 ou 3')
        return
    }

    if (session?.step === 'cancel') {
        await deleteSession(sender)
        await cancelReminder(sender, text.trim())
        return
    }

    if (textLower === 'criar lembrete') {
        await setSession(sender, { step: 'contact' })
        await sendMessage(sender, 'Qual o número do contato? (ex: 5598912345678)')
        return
    }

    if (textLower === 'listar lembretes') {
        await listReminders(sender)
        return
    }

    if (textLower.startsWith('cancelar lembrete')) {
        const parts = text.split(' ')
        if (parts.length === 3) {
            await cancelReminder(sender, parts[2])
        } else {
            await sendMessage(sender, 'Use: cancelar lembrete <id>')
        }
        return
    }

    if (session) {
        await handleFlow(sender, text, session)
        return
    }

    await sendMessage(sender,
        '🤖 *Bot de Lembretes*\n\n' +
        'Comandos disponíveis:\n\n' +
        '• *criar lembrete*\n' +
        '• *listar lembretes*\n' +
        '• *cancelar lembrete <id>*\n' +
        '• *bot lembrete* — menu interativo'
    )
}

async function handleFlow(sender, text, session) {
    if (text.toLowerCase() === 'cancelar') {
        await deleteSession(sender)
        await sendMessage(sender, 'Fluxo cancelado. Manda "bot lembrete" pra começar de novo.')
        return
    }

    const step = session.step

    if (step === 'contact') {
        if (!/^\d+$/.test(text)) {
            await sendMessage(sender, 'Por favor, manda só os números. Ex: 5598912345678')
            return
        }
        session.contact = text
        session.step = 'message'
        await setSession(sender, session)
        await sendMessage(sender, 'Qual a mensagem do lembrete?')

    } else if (step === 'message') {
        session.message = text
        session.step = 'datetime'
        await setSession(sender, session)
        await sendMessage(sender, 'Quando enviar pela primeira vez?\nFormato: DD/MM/AAAA HH:MM\nEx: 28/06/2026 08:00')

    } else if (step === 'datetime') {
        const parts = text.split(' ')
        if (parts.length !== 2) {
            await sendMessage(sender, 'Formato inválido. Use DD/MM/AAAA HH:MM')
            return
        }
        const [datePart, timePart] = parts
        const [day, month, year] = datePart.split('/')
        const [hour, minute] = timePart.split(':')
        const dt = new Date(year, month - 1, day, hour, minute)
        if (isNaN(dt.getTime())) {
            await sendMessage(sender, 'Data inválida. Use DD/MM/AAAA HH:MM')
            return
        }
        session.next_send_at = dt.toISOString()
        session.step = 'frequency'
        await setSession(sender, session)
        await sendMessage(sender,
            'Com qual frequência?\n\n' +
            '1 - Uma vez só\n' +
            '2 - Diário\n' +
            '3 - Semanal\n' +
            '4 - Mensal'
        )

    } else if (step === 'frequency') {
        const freqMap = { '1': 'once', '2': 'daily', '3': 'weekly', '4': 'monthly' }
        if (!freqMap[text]) {
            await sendMessage(sender, 'Manda só o número: 1, 2, 3 ou 4')
            return
        }
        session.frequency = freqMap[text]
        if (text === '1') {
            session.repeat_count = 1
            await deleteSession(sender)
            await saveReminder(sender, session)
        } else {
            session.step = 'repeat'
            await setSession(sender, session)
            await sendMessage(sender, 'Quantas vezes repetir?')
        }

    } else if (step === 'repeat') {
        if (!/^\d+$/.test(text) || parseInt(text) < 1) {
            await sendMessage(sender, 'Manda um número válido, ex: 7')
            return
        }
        session.repeat_count = parseInt(text)
        await deleteSession(sender)
        await saveReminder(sender, session)
    }
}

async function saveReminder(sender, session) {
    const freqLabels = {
        once: 'uma vez',
        daily: 'todo dia',
        weekly: 'toda semana',
        monthly: 'todo mês'
    }
    await supabase.from('reminders').insert({
        contact: session.contact,
        message: session.message,
        next_send_at: session.next_send_at,
        frequency: session.frequency,
        repeat_count: session.repeat_count,
        sent_count: 0,
        active: true
    })
    await sendMessage(sender,
        `✅ Lembrete criado!\n\n` +
        `📱 Contato: ${session.contact}\n` +
        `💬 Mensagem: ${session.message}\n` +
        `🕐 Primeiro envio: ${session.next_send_at}\n` +
        `🔁 Frequência: ${freqLabels[session.frequency]}\n` +
        `🔢 Repetições: ${session.repeat_count}`
    )
}

async function listReminders(sender) {
    const result = await supabase.from('reminders').select('*').eq('active', true)
    if (!result.data || result.data.length === 0) {
        await sendMessage(sender, 'Nenhum lembrete ativo no momento.')
        return
    }
    let msg = '📋 *Lembretes ativos:*\n\n'
    for (const r of result.data) {
        msg += `🔹 ID: ${r.id.slice(0, 8)}\n   Contato: ${r.contact}\n   Mensagem: ${r.message}\n   Próximo envio: ${r.next_send_at}\n\n`
    }
    await sendMessage(sender, msg)
}

async function cancelReminder(sender, reminderId) {
    const result = await supabase.from('reminders').select('id').eq('active', true)
    if (!result.data || result.data.length === 0) {
        await sendMessage(sender, 'Nenhum lembrete ativo encontrado.')
        return
    }
    const found = result.data.find(r => r.id.startsWith(reminderId.toLowerCase()))
    if (!found) {
        await sendMessage(sender, `Lembrete ${reminderId} não encontrado.`)
        return
    }
    await supabase.from('reminders').update({ active: false }).eq('id', found.id)
    await sendMessage(sender, `✅ Lembrete ${reminderId} cancelado.`)
}

async function runDispatcher() {
    if (!sock || !sock.authState?.creds?.me) return

    const now = new Date().toISOString()
    const result = await supabase.from('reminders').select('*').eq('active', true).lte('next_send_at', now)
    if (!result.data || result.data.length === 0) return

    for (const reminder of result.data) {
        try {
            await sock.sendMessage(`${reminder.contact}@s.whatsapp.net`, { text: reminder.message })
            const newSentCount = reminder.sent_count + 1

            if (reminder.frequency === 'once' || newSentCount >= reminder.repeat_count) {
                await supabase.from('reminders').update({ active: false, sent_count: newSentCount }).eq('id', reminder.id)
            } else {
                const next = new Date()
                if (reminder.frequency === 'daily') next.setDate(next.getDate() + 1)
                else if (reminder.frequency === 'weekly') next.setDate(next.getDate() + 7)
                else if (reminder.frequency === 'monthly') next.setMonth(next.getMonth() + 1)
                await supabase.from('reminders').update({ sent_count: newSentCount, next_send_at: next.toISOString() }).eq('id', reminder.id)
            }
            console.log(`Lembrete enviado para ${reminder.contact}`)
        } catch (err) {
            console.error(`Erro ao enviar para ${reminder.contact}: ${err.message}`)
            // Não marca como enviado — vai tentar de novo no próximo ciclo
        }
    }
}

const server = http.createServer(async (req, res) => {
    if (req.url === '/qr' && currentQR) {
        const qrImage = await QRCode.toDataURL(currentQR)
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
            <html>
                <body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;">
                    <div style="text-align:center;">
                        <h2 style="color:white;font-family:sans-serif;">Escaneie o QR Code</h2>
                        <img src="${qrImage}" style="width:300px;height:300px;">
                        <p style="color:#aaa;font-family:sans-serif;">WhatsApp > Aparelhos conectados > Conectar um aparelho</p>
                        <p style="color:#aaa;font-family:sans-serif;">⚠️ O QR expira em 60 segundos. Recarregue a página se necessário.</p>
                    </div>
                </body>
            </html>
        `)
    } else if (req.url === '/qr' && !currentQR) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body style="background:#111;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;"><h2>✅ Bot já conectado!</h2></body></html>`)
    } else {
        res.writeHead(200)
        res.end('Bot rodando!')
    }
})
server.listen(process.env.PORT || 3000)

setInterval(runDispatcher, 60 * 1000)

connectToWhatsApp()
