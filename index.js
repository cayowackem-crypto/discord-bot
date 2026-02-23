require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    PermissionsBitField,
    Partials,
    AuditLogEvent
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction
    ]
});

const reactionRoles = new Map();
const roleDeleteTracker = new Map();
const channelDeleteTracker = new Map();
const messageTracker = new Map();


// ---------------- SLASH COMMANDS ----------------

const commands = [

    new SlashCommandBuilder()
        .setName('announce')
        .setDescription('Send an announcement')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('The announcement message')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('reactionrole')
        .setDescription('Create a reaction role message')
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('Role to give')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('emoji')
                .setDescription('Emoji to react with')
                .setRequired(true)
        )

].map(command => command.toJSON());


// ---------------- REGISTER COMMANDS ----------------

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    const GUILD_ID = "1398351890462277825";

    await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
    );

    console.log('Slash commands registered.');
});


// ---------------- INTERACTIONS ----------------

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'announce') {

        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'Admin only.', ephemeral: true });
        }

        const message = interaction.options.getString('message');

        await interaction.reply({ content: 'Announcement sent!', ephemeral: true });
        await interaction.channel.send(`📢 **Announcement:**\n${message}`);
    }

    if (interaction.commandName === 'reactionrole') {

        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'Admin only.', ephemeral: true });
        }

        const role = interaction.options.getRole('role');
        const emoji = interaction.options.getString('emoji');

        const message = await interaction.channel.send(
            `React with ${emoji} to get the ${role.name} role!`
        );

        await message.react(emoji);

        reactionRoles.set(message.id, {
            roleId: role.id,
            emoji: emoji
        });

        await interaction.reply({ content: 'Reaction role created!', ephemeral: true });
    }
});


// ---------------- REACTION ROLE HANDLING ----------------

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();

    const data = reactionRoles.get(reaction.message.id);
    if (!data) return;
    if (reaction.emoji.name !== data.emoji) return;

    const member = await reaction.message.guild.members.fetch(user.id);
    await member.roles.add(data.roleId).catch(() => {});
});

client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();

    const data = reactionRoles.get(reaction.message.id);
    if (!data) return;
    if (reaction.emoji.name !== data.emoji) return;

    const member = await reaction.message.guild.members.fetch(user.id);
    await member.roles.remove(data.roleId).catch(() => {});
});


// ---------------- ROLE DELETE PROTECTION ----------------

client.on('roleDelete', async role => {
    const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 1 });
    const entry = logs.entries.first();
    if (!entry) return;

    const executor = await role.guild.members.fetch(entry.executor.id);

    if (
        executor.id === role.guild.ownerId ||
        executor.permissions.has(PermissionsBitField.Flags.Administrator) ||
        executor.user.bot
    ) return;

    const now = Date.now();
    const data = roleDeleteTracker.get(executor.id) || { count: 0, time: now };

    if (now - data.time > 10000) {
        data.count = 0;
        data.time = now;
    }

    data.count++;
    roleDeleteTracker.set(executor.id, data);

    if (data.count >= 4) {
        for (const r of executor.roles.cache.values()) {
            if (r.id !== role.guild.id) {
                await executor.roles.remove(r).catch(() => {});
            }
        }
        console.log(`Anti-Nuke: Stripped roles from ${executor.user.tag}`);
    }
});


// ---------------- CHANNEL DELETE PROTECTION ----------------

client.on('channelDelete', async channel => {
    const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 1 });
    const entry = logs.entries.first();
    if (!entry) return;

    const executor = await channel.guild.members.fetch(entry.executor.id);

    if (
        executor.id === channel.guild.ownerId ||
        executor.permissions.has(PermissionsBitField.Flags.Administrator) ||
        executor.user.bot
    ) return;

    const now = Date.now();
    const data = channelDeleteTracker.get(executor.id) || { count: 0, time: now };

    if (now - data.time > 10000) {
        data.count = 0;
        data.time = now;
    }

    data.count++;
    channelDeleteTracker.set(executor.id, data);

    if (data.count >= 4) {
        await executor.ban({ reason: 'Anti-Nuke: Mass channel deletion' }).catch(() => {});
        console.log(`Anti-Nuke: Banned ${executor.user.tag}`);
    }
});


// ---------------- SPAM PROTECTION ----------------

client.on('messageCreate', async message => {
    if (!message.guild) return;
    if (message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    if (message.author.bot) return;

    const now = Date.now();
    const data = messageTracker.get(message.author.id) || [];

    data.push(now);
    messageTracker.set(message.author.id, data.filter(t => now - t < 60000));

    const recent5s = data.filter(t => now - t < 5000).length;
    const recent60s = data.length;

    if (recent5s >= 15 || recent60s >= 60) {
        await message.member.timeout(5 * 60 * 1000, 'Spam detected').catch(() => {});
        messageTracker.delete(message.author.id);
        console.log(`Spam Protection: Timed out ${message.author.tag}`);
    }
});


client.login(process.env.TOKEN);