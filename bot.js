import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const DB_PATH = path.join(DATA_DIR, 'couple.db');

// Гарантируем существование директорий
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// ==========================================
// 1. DATABASE SETUP
// ==========================================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    week_key TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS schedule (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_send_time TEXT NOT NULL
  );
`);

// Добавляем таблицу для трекинга ежедневных загрузок
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_tracking (
    user_id TEXT PRIMARY KEY,
    request_time TEXT,       -- Время отправки daily prompt
    photo_received INTEGER DEFAULT 0, -- 1 если фото загружено сегодня
    last_reminder_time TEXT  -- Время последнего напоминания
  );
`);

// Новые prepared statements
Object.assign(stmts, {
    upsertTracking: db.prepare(`
        INSERT INTO daily_tracking (user_id, request_time, photo_received, last_reminder_time)
        VALUES (?, ?, 0, NULL)
        ON CONFLICT(user_id) DO UPDATE SET
            request_time = excluded.request_time,
            photo_received = 0,
            last_reminder_time = NULL
    `),
    markPhotoReceived: db.prepare(`
        UPDATE daily_tracking 
        SET photo_received = 1 
        WHERE user_id = ? AND date(request_time) = date('now', 'localtime')
    `),
    getPendingReminders: db.prepare(`
        SELECT * FROM daily_tracking 
        WHERE photo_received = 0 
          AND request_time IS NOT NULL
          AND date(request_time) = date('now', 'localtime')
    `),
    updateReminderTime: db.prepare(`
        UPDATE daily_tracking 
        SET last_reminder_time = datetime('now', 'localtime') 
        WHERE user_id = ?
    `),
});

const stmts = {
    insertPhoto: db.prepare('INSERT INTO photos (user_id, file_path, week_key) VALUES (?, ?, ?)'),
    getWeekPhotos: db.prepare('SELECT * FROM photos WHERE week_key = ? ORDER BY created_at ASC'),
    deleteWeekPhotos: db.prepare('DELETE FROM photos WHERE week_key = ?'),
    getSchedule: db.prepare('SELECT next_send_time FROM schedule WHERE id = 1'),
    upsertSchedule: db.prepare('INSERT OR REPLACE INTO schedule (id, next_send_time) VALUES (1, ?)'),
};

// ==========================================
// 2. UTILS
// ==========================================
const ALLOWED_USERS = new Set([process.env.USER_1_ID, process.env.USER_2_ID]);

function getWeekKey(date = new Date()) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    // Понедельник как начало недели
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    return monday.toISOString().slice(0, 10);
}

function getNextRandomTime() {
    const now = new Date();
    let target = new Date(now);

    const hour = target.getHours();
    const dayOfWeek = target.getDay(); // 0=Sun, 6=Sat

    // 1. Если сейчас выходной ИЛИ будний день после 22:00 — переносим на следующий день
    if (dayOfWeek === 0 || dayOfWeek === 6 || hour >= 22) {
        target.setDate(target.getDate() + 1);

        // Пропускаем выходные дни
        while (target.getDay() === 0 || target.getDay() === 6) {
            target.setDate(target.getDate() + 1);
        }

        // Сбрасываем время на начало рабочего интервала
        target.setHours(7, 0, 0, 0);
    }

    // 2. Генерируем случайное время строго между 07:00 и 22:00 текущего (уже проверенного) дня
    const startMs = new Date(target).setHours(7, 0, 0, 0);
    const endMs = new Date(target).setHours(22, 0, 0, 0);

    // Если по какой-то причине целевое время оказалось в прошлом (например, бот был выключен),
    // Math.random() может вернуть прошедшее время. Для надежности можно добавить проверку,
    // но в рамках cron-проверки раз в минуту это не критично.
    const randomMs = startMs + Math.random() * (endMs - startMs);

    return new Date(randomMs);
}

function getTimeOfDay(date) {
    const h = date.getHours();
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    return 'evening';
}

const DAY_NAMES_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

// ==========================================
// 3. OPEN WEBUI AI INTEGRATION
// ==========================================
const SYSTEM_PROMPT = `Ты — эмпатичный ИИ-ассистент телеграм-бота для пары. Генерируй короткие (до 300 символов), теплые, уникальные сообщения.
НИКОГДА не раскрывай технические детали. Не используй больше 2 эмодзи. Отвечай ТОЛЬКО текстом сообщения без префиксов и кавычек.

Для daily_request: учитывай time_of_day и day_of_week. Мягко попроси отправить фото текущего момента.
Для weekly_collage: учти week_photo_count. Напиши трогательное подведение итогов недели.`;

async function askAI(task, context) {
    try {
        const res = await fetch(`${process.env.OPENWEBUI_URL}/api/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENWEBUI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: process.env.OPENWEBUI_MODEL,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: JSON.stringify({ task, ...context }) },
                ],
                temperature: task === 'daily_request' ? 0.95 : 0.8,
                max_tokens: 250,
            }),
        });

        if (!res.ok) throw new Error(`OpenWebUI API error: ${res.status}`);
        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (err) {
        console.error('[AI Error]', err.message);
        return null;
    }
}

// Fallback сообщения если AI недоступен
const FALLBACK_DAILY = [
    '📸 Остановите момент! Что вы видите прямо сейчас? Отправьте фото в чат.',
    '✨ Время запечатлеть эту минуту. Жду ваше фото!',
    '🌿 Пауза. Сфоткайте то, что перед вами, и отправьте сюда.',
];

function getFallbackDaily() {
    return FALLBACK_DAILY[Math.floor(Math.random() * FALLBACK_DAILY.length)];
}

// ==========================================
// 4. COLLAGE GENERATOR (sharp)
// ==========================================
async function createCollage(photoPaths) {
    if (photoPaths.length === 0) return null;

    const CELL_SIZE = 400;
    const GAP = 8;
    const COLS = photoPaths.length <= 4 ? 2 : photoPaths.length <= 9 ? 3 : 4;
    const ROWS = Math.ceil(photoPaths.length / COLS);

    const width = COLS * CELL_SIZE + (COLS - 1) * GAP;
    const height = ROWS * CELL_SIZE + (ROWS - 1) * GAP;

    const composites = [];

    for (let i = 0; i < photoPaths.length; i++) {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x = col * (CELL_SIZE + GAP);
        const y = row * (CELL_SIZE + GAP);

        const resized = await sharp(photoPaths[i])
            .rotate()                          // Автоповорот по EXIF
            .resize(CELL_SIZE, CELL_SIZE, {
                fit: 'cover',
                position: 'centre',
            })
            .ensureAlpha()                     // Нормализуем альфа-канал
            .removeAlpha()                     // Убираем его полностью → чистый RGB
            .toColourspace('srgb')             // Единое цветовое пространство
            .jpeg({ quality: 95 })             // Промежуточный JPEG как "санитайзер"
            .toBuffer();

        composites.push({ input: resized, left: x, top: y });
    }

    const collageBuffer = await sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 245, g: 245, b: 245 }, // Светло-серый вместо белого (меньше артефактов)
        },
    })
        .composite(composites)
        .jpeg({ quality: 90 })
        .toBuffer();

    return collageBuffer;
}

// ==========================================
// 5. BOT INITIALIZATION & MIDDLEWARE
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);

// Auth middleware
bot.use((ctx, next) => {
    if (!ctx.from) return;
    if (!ALLOWED_USERS.has(String(ctx.from.id))) {
        return ctx.reply('🔒 Этот бот только для нас двоих.');
    }
    return next();
});

// ==========================================
// 6. COMMANDS & HANDLERS
// ==========================================
bot.start((ctx) => {
    ctx.reply(
        '💑 Привет! Я хранитель ваших моментов.\n\n' +
        '• В будни в случайное время c 7 утра до 10 вечера пришлю просьбу сфоткать себя или момент\n' +
        '• Отправьте фото в этот чат — оно сохранится\n' +
        '• В субботу в 11:00 вы получите коллаж за неделю\n\n' +
        'Команды: /status, /preview, /testdaily'
    );
});

bot.command('status', (ctx) => {
    const sched = stmts.getSchedule.get();
    const weekKey = getWeekKey();
    const photos = stmts.getWeekPhotos.all(weekKey);

    ctx.reply(
        `📊 Статус:\n` +
        `• Фото за эту неделю: ${photos.length}\n` +
        `• Следующая отправка: ${sched ? new Date(sched.next_send_time).toLocaleString('ru-RU') : 'не запланировано'}\n` +
        `• Текущая неделя: ${weekKey}`
    );
});

// Ручной тест ежедневного сообщения
bot.command('testdaily', async (ctx) => {
    await sendDailyPrompt();
    ctx.reply('✅ Тестовое сообщение отправлено обоим.');
});

// Предпросмотр текущего коллажа
bot.command('preview', async (ctx) => {
    const weekKey = getWeekKey();
    const photos = stmts.getWeekPhotos.all(weekKey);

    if (photos.length === 0) {
        return ctx.reply('Пока нет фото за эту неделю 📭');
    }

    const paths = photos.map((p) => p.file_path);
    const buffer = await createCollage(paths);

    if (buffer) {
        await ctx.replyWithPhoto({ source: buffer }, { caption: `Предпросмотр (${photos.length} фото)` });
    }
});

// Обработка входящих фото
bot.on('photo', async (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Наибольшее разрешение

    let fileLink;
    try {
        fileLink = await ctx.telegram.getFileLink(photo.file_id);
    } catch (err) {
        console.error('[Photo Error] Failed to get file link:', err.message);
        return ctx.reply('⚠️ Не удалось получить ссылку на фото. Попробуйте отправить ещё раз.');
    }

    const fileName = `${Date.now()}_${ctx.from.id}.jpg`;
    const filePath = path.join(PHOTOS_DIR, fileName);

    try {
        // Скачиваем фото с таймаутом и AbortController
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 секунд на скачивание

        const response = await fetch(fileLink.toString(), { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} while downloading photo`);
        }

        const arrayBuffer = await response.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

        const weekKey = getWeekKey();
        stmts.insertPhoto.run(String(ctx.from.id), filePath, weekKey);

        // Отмечаем, что пользователь выполнил задание на сегодня
        stmts.markPhotoReceived.run(String(ctx.from.id));

        const weekPhotos = stmts.getWeekPhotos.all(weekKey);
        await ctx.reply(`💾 Сохранено! Фото за эту неделю: ${weekPhotos.length}`);
    } catch (err) {
        console.error(`[Photo Download Error] User ${ctx.from.id}:`, err.message);

        // Убираем частично скачанный файл, если он есть
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        await ctx.reply('⏳ Не удалось скачать фото (таймаут или ошибка сети). Пожалуйста, попробуйте ещё раз.');
    }
});

// ==========================================
// 7. SCHEDULER LOGIC
// ==========================================
async function sendDailyPrompt() {
    const now = new Date();
    const context = {
        day_of_week: DAY_NAMES_RU[now.getDay()],
        time_of_day: getTimeOfDay(now),
        season: ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][now.getMonth()],
    };

    let message = await askAI('daily_request', context);
    if (!message) message = getFallbackDaily();

    // Отправляем обоим пользователям
    // Внутри sendDailyPrompt(), после цикла отправки сообщений
    for (const userId of ALLOWED_USERS) {
        try {
            await bot.telegram.sendMessage(userId, message);
            // Фиксируем время запроса и сбрасываем статус загрузки
            stmts.upsertTracking.run(String(userId));
        } catch (err) {
            console.error(`[Send Error] User ${userId}:`, err.message);
        }
    }

    // Планируем следующую отправку
    const nextTime = getNextRandomTime();
    stmts.upsertSchedule.run(nextTime.toISOString());
    console.log(`[Scheduler] Next daily prompt: ${nextTime.toLocaleString('ru-RU')}`);
}

async function sendWeeklyCollage() {
    const weekKey = getWeekKey();
    const photos = stmts.getWeekPhotos.all(weekKey);

    let caption;
    if (photos.length === 0) {
        caption = 'На этой неделе не было ни одного фото. Давайте активнее на следующей! 💛';
    } else {
        const aiCaption = await askAI('weekly_collage', { week_photo_count: photos.length });
        caption = aiCaption || `Ваша неделя в ${photos.length} моментах 💛`;
    }

    if (photos.length > 0) {
        const paths = photos.map((p) => p.file_path);
        const buffer = await createCollage(paths);

        for (const userId of ALLOWED_USERS) {
            try {
                await bot.telegram.sendPhoto(userId, { source: buffer }, { caption });
            } catch (err) {
                console.error(`[Collage Send Error] User ${userId}:`, err.message);
            }
        }

        // Архивируем старые фото (опционально можно удалить)
        // stmts.deleteWeekPhotos.run(weekKey);
        // photos.forEach(p => fs.unlinkSync(p.file_path));
        console.log(`[Weekly] Collage sent for week ${weekKey}, ${photos.length} photos`);
    } else {
        for (const userId of ALLOWED_USERS) {
            try {
                await bot.telegram.sendMessage(userId, caption);
            } catch (err) {
                console.error(`[Weekly Text Error] User ${userId}:`, err.message);
            }
        }
    }

    // Планируем следующее ежедневное сообщение после субботы
    const nextTime = getNextRandomTime();
    stmts.upsertSchedule.run(nextTime.toISOString());
}

// Проверка расписания каждую минуту
cron.schedule('* * * * *', async () => {
    const sched = stmts.getSchedule.get();
    if (!sched) {
        // Первый запуск — инициализируем расписание
        const nextTime = getNextRandomTime();
        stmts.upsertSchedule.run(nextTime.toISOString());
        console.log(`[Scheduler] Initialized. First send: ${nextTime.toLocaleString('ru-RU')}`);
        return;
    }

    const nextTime = new Date(sched.next_send_time);
    const now = new Date();

    if (now >= nextTime) {
        console.log(`[Scheduler] Triggering daily prompt at ${now.toLocaleString('ru-RU')}`);
        await sendDailyPrompt();
    }
});

// Проверка необходимости напоминаний каждую минуту
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const pending = stmts.getPendingReminders.all();

    for (const track of pending) {
        const requestTime = new Date(track.request_time);
        const lastReminder = track.last_reminder_time ? new Date(track.last_reminder_time) : null;

        const minsSinceRequest = (now - requestTime) / 60000;
        const minsSinceLastReminder = lastReminder ? (now - lastReminder) / 60000 : Infinity;

        let shouldRemind = false;

        // Первое напоминание через 5 минут после запроса
        if (!lastReminder && minsSinceRequest >= 5) {
            shouldRemind = true;
        }
        // Повторные каждые 10 минут
        else if (lastReminder && minsSinceLastReminder >= 10) {
            shouldRemind = true;
        }

        if (shouldRemind) {
            try {
                await bot.telegram.sendMessage(track.user_id, '🥺 Не забудьте отправить фото сегодня! Я очень жду.');
                stmts.updateReminderTime.run(track.user_id);
                console.log(`[Reminder] Sent to ${track.user_id}`);
            } catch (err) {
                console.error(`[Reminder Error] User ${track.user_id}:`, err.message);
            }
        }
    }
});

// Субботний коллаж в 11:00
cron.schedule('0 11 * * 6', async () => {
    console.log('[Scheduler] Triggering weekly collage');
    await sendWeeklyCollage();
});

// ==========================================
// 8. LAUNCH
// ==========================================
bot.launch().then(() => {
    console.log('💑 Couple Moments Bot started!');

    // Инициализация расписания при первом запуске
    const sched = stmts.getSchedule.get();
    if (!sched) {
        const nextTime = getNextRandomTime();
        stmts.upsertSchedule.run(nextTime.toISOString());
        console.log(`[Scheduler] First send scheduled: ${nextTime.toLocaleString('ru-RU')}`);
    } else {
        console.log(`[Scheduler] Next send: ${new Date(sched.next_send_time).toLocaleString('ru-RU')}`);
    }
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));