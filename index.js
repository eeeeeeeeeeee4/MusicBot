const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    getVoiceConnection
} = require('@discordjs/voice');

const play = require('play-dl');
const { spawn } = require('child_process');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = '1548239932093628497';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// قائمة مستقلة لكل سيرفر
const queues = new Map();

const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('تشغيل أغنية أو إضافتها لقائمة الانتظار')
        .addStringOption(option =>
            option
                .setName('song')
                .setDescription('اسم الأغنية أو رابط YouTube / SoundCloud')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('تخطي الأغنية الحالية'),

    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('إيقاف الأغنية مؤقتاً'),

    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('استكمال تشغيل الأغنية'),

    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('عرض قائمة الانتظار'),

    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('إيقاف الأغاني ومسح القائمة والخروج')
].map(command => command.toJSON());

client.once('clientReady', async () => {
    console.log(`Bot online: ${client.user.tag}`);

    try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);

        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: commands }
        );

        console.log('Commands registered!');
    } catch (error) {
        console.error('COMMAND ERROR:', error);
    }
});

async function searchSong(query) {
    // إذا كان رابط
    if (query.startsWith('http://') || query.startsWith('https://')) {
        return {
            title: query,
            url: query
        };
    }

    // إذا كان اسم أغنية، ابحث في YouTube
    const results = await play.search(query, {
        limit: 1,
        source: { youtube: 'video' }
    });

    if (!results || results.length === 0) {
        return null;
    }

    return {
        title: results[0].title,
        url: results[0].url
    };
}

async function playNext(guildId) {
    const serverQueue = queues.get(guildId);

    if (!serverQueue) return;

    if (serverQueue.songs.length === 0) {
        serverQueue.playing = false;
        serverQueue.current = null;
        return;
    }

    const song = serverQueue.songs.shift();

    serverQueue.current = song;
    serverQueue.playing = true;

    console.log(`PLAYING: ${song.title}`);
    console.log(`URL: ${song.url}`);

    const ytdlpPath = process.platform === 'win32'
    ? path.join(__dirname, 'yt-dlp.exe')
    : '/root/.nix-profile/bin/yt-dlp';
    const ytdlp = spawn(ytdlpPath, [
        '-f', 'bestaudio/best',
        '-o', '-',
        '--no-playlist',
        song.url
    ], {
        windowsHide: true
    });

    serverQueue.process = ytdlp;

    ytdlp.stderr.on('data', data => {
        console.log('YT-DLP:', data.toString());
    });

    ytdlp.on('error', error => {
        console.error('YT-DLP ERROR:', error);
    });

    const resource = createAudioResource(ytdlp.stdout);

    serverQueue.player.play(resource);

    serverQueue.player.once(AudioPlayerStatus.Idle, () => {
        if (serverQueue.process) {
            serverQueue.process.kill();
            serverQueue.process = null;
        }

        playNext(guildId);
    });
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guild.id;

    // PLAY
    if (interaction.commandName === 'play') {
        await interaction.deferReply();

        try {
            const member = await interaction.guild.members.fetch(
                interaction.user.id
            );

            const voiceChannel = member.voice.channel;

            if (!voiceChannel) {
                return interaction.editReply(
                    '❌ ادخل روم صوتي أول.'
                );
            }

            const query = interaction.options.getString('song', true);

            const song = await searchSong(query);

            if (!song) {
                return interaction.editReply(
                    '❌ ما لقيت الأغنية.'
                );
            }

            let serverQueue = queues.get(guildId);

            // إذا ما عندنا Queue لهذا السيرفر، نسويه
            if (!serverQueue) {
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: guildId,
                    adapterCreator:
                        interaction.guild.voiceAdapterCreator,
                    selfDeaf: true
                });

                await entersState(
                    connection,
                    VoiceConnectionStatus.Ready,
                    20_000
                );

                const player = createAudioPlayer();

                connection.subscribe(player);

                serverQueue = {
                    connection,
                    player,
                    songs: [],
                    current: null,
                    playing: false,
                    process: null
                };

                player.on('error', error => {
                    console.error('PLAYER ERROR:', error);
                });

                queues.set(guildId, serverQueue);
            }

            serverQueue.songs.push(song);

            if (!serverQueue.playing) {
                await interaction.editReply(
                    `🎵 جاري تشغيل: **${song.title}**`
                );

                playNext(guildId);
            } else {
                await interaction.editReply(
                    `➕ تمت إضافة **${song.title}** إلى قائمة الانتظار.`
                );
            }

        } catch (error) {
            console.error('PLAY ERROR:', error);

            await interaction.editReply(
                '❌ صار خطأ أثناء تشغيل الأغنية.'
            ).catch(() => {});
        }
    }

    // SKIP
    if (interaction.commandName === 'skip') {
        const serverQueue = queues.get(guildId);

        if (!serverQueue || !serverQueue.current) {
            return interaction.reply(
                '❌ ما فيه أغنية شغالة حالياً.'
            );
        }

        if (serverQueue.process) {
            serverQueue.process.kill();
            serverQueue.process = null;
        }

        serverQueue.player.stop();

        await interaction.reply('⏭️ تم تخطي الأغنية.');
    }

    // PAUSE
    if (interaction.commandName === 'pause') {
        const serverQueue = queues.get(guildId);

        if (!serverQueue || !serverQueue.current) {
            return interaction.reply(
                '❌ ما فيه أغنية شغالة حالياً.'
            );
        }

        serverQueue.player.pause();

        await interaction.reply('⏸️ تم إيقاف الأغنية مؤقتاً.');
    }

    // RESUME
    if (interaction.commandName === 'resume') {
        const serverQueue = queues.get(guildId);

        if (!serverQueue || !serverQueue.current) {
            return interaction.reply(
                '❌ ما فيه أغنية متوقفة.'
            );
        }

        serverQueue.player.unpause();

        await interaction.reply('▶️ تم استكمال الأغنية.');
    }

    // QUEUE
    if (interaction.commandName === 'queue') {
        const serverQueue = queues.get(guildId);

        if (!serverQueue || !serverQueue.current) {
            return interaction.reply(
                '📭 قائمة الانتظار فاضية.'
            );
        }

        let message =
            `🎵 **شغال الآن:**\n${serverQueue.current.title}\n\n`;

        if (serverQueue.songs.length === 0) {
            message += '📭 ما فيه أغاني بعدها.';
        } else {
            message += '📋 **الأغاني القادمة:**\n';

            serverQueue.songs.slice(0, 10).forEach((song, index) => {
                message += `${index + 1}. ${song.title}\n`;
            });
        }

        await interaction.reply(message);
    }

    // STOP
    if (interaction.commandName === 'stop') {
        const serverQueue = queues.get(guildId);

        if (serverQueue) {
            serverQueue.songs = [];

            if (serverQueue.process) {
                serverQueue.process.kill();
            }

            serverQueue.player.stop();

            try {
                serverQueue.connection.destroy();
            } catch {}

            queues.delete(guildId);
        } else {
            const connection = getVoiceConnection(guildId);

            if (connection) {
                connection.destroy();
            }
        }

        await interaction.reply(
            '⏹️ تم إيقاف الأغاني ومسح قائمة الانتظار.'
        );
    }
});

client.login(TOKEN);