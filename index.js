/*
 TODO:
 - [ ] buat 2 sistem weather (nowacast based on kecamatan, weather biasa)
 - [ ] buat sistem buat nowacastnya nanya ke user buat lebih spesifik mau tepatnya di lokasi yang mana
 - [ ]
 */

import "dotenv/config";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
} from "discord.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import { InferenceClient } from "@huggingface/inference";
import { DOMParser } from "xmldom";

// ---------- CONFIG ----------
const PREFIX = "!";
const BMKG_URL =
  process.env.BMKG_URL || "https://api.bmkg.go.id/weather/jakarta"; // replace if needed
const ALERT_CHANNEL_ID = process.env.ALERT_CHANNEL_ID || null;

const HUGGING_API_LIST = [
  process.env.HUGGING_API,
  process.env.HUGGING_API2,
  process.env.HUGGING_API3,
];

let HUGGING_INDEX = 0;
let HUGGING_FACE_API_KEY = HUGGING_API_LIST[HUGGING_INDEX] || null;

const DATA_DIR = "./data";
const SUBSCRIBERS_FILE = path.join(DATA_DIR, "subscribers.json");
const FACTS_FILE = path.join(DATA_DIR, "facts.json");
const QUOTES_FILE = path.join(DATA_DIR, "quotes.json");
const KODE_WILAYAH_FILE = path.join(DATA_DIR, "kode_wilayah.json");
const wilayahData = fs.existsSync(KODE_WILAYAH_FILE)
  ? JSON.parse(fs.readFileSync(KODE_WILAYAH_FILE, "utf8"))
  : [];

// ---------- ENSURE DATA FOLDER ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SUBSCRIBERS_FILE)) {
  fs.writeFileSync(SUBSCRIBERS_FILE, "[]", "utf8");
}
if (!fs.existsSync(FACTS_FILE)) {
  fs.writeFileSync(FACTS_FILE, JSON.stringify([], null, 2), "utf8");
}
if (!fs.existsSync(QUOTES_FILE)) {
  fs.writeFileSync(
    QUOTES_FILE,
    JSON.stringify(
      [
        "Get excited! This is the power of science! — Senku Ishigami",
        "Nothing is impossible with science! — Senku",
        "Science is just a name for the pursuit of knowledge! — Senku",
        "If you don't give up, you can't fail! — Chrome",
      ],
      null,
      2,
    ),
    "utf8",
  );
}

// ---------- UTILITIES ----------
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeJSON = (p, obj) =>
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
const quotes = readJSON(QUOTES_FILE);
const facts = readJSON(FACTS_FILE);
let hf = new InferenceClient(HUGGING_FACE_API_KEY);

// ---------- DISCORD CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- LOGIN ----------
client.on("clientReady", async () => {
  console.log(`🤖 Kingdom of Science logged in as ${client.user.tag}`);
  console.log("[MODE-AI] Waiting for sada to wake up");
  // deleteMemory()
  console.log("[MODE-AI] Sada is Online and ready to fully assist you");
});

// ---------- AI HELPERS ----------
async function askAI(prompt, model = "ibm-granite/granite-4.0-micro") {
  try {
    // Instruct the model to output a single-line header first in this exact format:
    // '<call_flag> <intent> <location>;' followed by two newlines and the normal chatbot response.
    // Example: '1 rain Jakarta Selatan;\n\nHere's the forecast...'
    // call_flag: '1' means the bot should call the BMKG API for the given location. '0' means no call.
    const systemInstruction = `When you reply, based on the user's query, start with a single-line header exactly in this format:\n` +
      `'<call_flag> <Weather|rain> <location>;' (no quotes).` +
      `call_flag must be 1 if the user is asking for a weather forecast or anything weather related like rain or flooding or 0 if the user does not ask for it.` +
      ` After the header, add a blank line, then the regular chat response. Example:\n` +
      `1 rain Jakarta Selatan;\n\nHere is the forecast for Jakarta Selatan...`;

    const response = await hf.chatCompletion({
      model: "meta-llama/Llama-3.1-8B-Instruct",
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: prompt },
      ],
      max_tokens: 512,
    });
    HUGGING_INDEX++;
    if (HUGGING_INDEX > 2) HUGGING_INDEX = 0;
    console.log(HUGGING_FACE_API_KEY);
    HUGGING_FACE_API_KEY = HUGGING_API_LIST[HUGGING_INDEX];
    // Some models return a plain string, others return an array/object
    const text =
      response.choices[0].message.content ||
      response[0]?.message.content ||
      response?.output_text ||
      "🤔 No response.";

    return text;
  } catch (error) {
    console.error("❌ AI Error:", error);
    return "⚠️ AI failed to respond. Please try again later.";
  }
}

function sendLongMessage(channel, text) {
  const chunks = text.match(/[\s\S]{1,1999}/g); // split text into 2000-char safe chunks
  for (const chunk of chunks) {
    channel.send(chunk);
  }
}

function findWilayahCode(cityName = "jakarta") {
  // Normalize string: lowercase and remove non-alphanumeric (basic)
  const normalize = (s = "") =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim();

  const q = normalize(cityName);
  if (!q) return null;

  // fields to try matching against, in order of granularity
  const fields = ["kelurahan", "kecamatan", "kab_kota", "provinsi"];

  // 1) direct contains match across fields
  let found = wilayahData.find((w) =>
    fields.some((f) => w[f] && normalize(w[f]).includes(q)),
  );
  if (found) return found;

  // 2) try matching by tokens (e.g., 'Jakarta Selatan' -> try 'selatan')
  const parts = q.split(/\s+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const token = parts.slice(i).join(" ");
    found = wilayahData.find((w) =>
      fields.some((f) => w[f] && normalize(w[f]).includes(token)),
    );
    if (found) return found;
  }

  // 3) fallback: startsWith
  found = wilayahData.find((w) =>
    fields.some((f) => w[f] && normalize(w[f]).startsWith(q)),
  );

  return found || null;
}

async function earlyWarning() {
  // https://www.bmkg.go.id/alerts/nowcast/id
  const { data } = await axios.get("https://www.bmkg.go.id/alerts/nowcast/id");

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(data, "text/xml");

  const items = xmlDoc.getElementsByTagName("item");

  const alerts = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const link = item.getElementsByTagName("link")[0]?.textContent || "";

    const { data } = await axios.get(link);
    const moreDetailData = parser.parseFromString(data, "text/xml");

    const imgActualLink =
      moreDetailData.getElementsByTagName("web")[0]?.textContent;
    const title =
      moreDetailData.getElementsByTagName("headline")[0]?.textContent || "";
    const description =
      moreDetailData.getElementsByTagName("description")[0]?.textContent || "";
    const effective =
      moreDetailData.getElementsByTagName("effective")[0]?.textContent || "";
    const expired =
      moreDetailData.getElementsByTagName("expires")[0]?.textContent || "";
    const senderName =
      moreDetailData.getElementsByTagName("senderName")[0]?.textContent || "";

    alerts.push({
      title,
      link,
      imgActualLink,
      description,
      effective,
      expired,
      senderName,
    });
  }

  // console.log(alerts);
  return alerts;
}

// earlyWarning();
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  const [cmd, ...args] = message.content
    .trim()
    .substring(PREFIX.length)
    .split(/\s+/);

  switch (cmd.toLowerCase()) {
    case "ping":
      message.reply("🏓 Pong! Kingdom of Science is online!");
      break;
    case "weather":
      if (args.length === 0) {
        return message.reply(
          "🌦 Please provide a city name, e.g. `!weather Jakarta`",
        );
      }

      const city = args.join(" ");
      const wilayah = findWilayahCode(city);

      if (!wilayah) {
        return message.reply(
          `❌ Sorry, I can't find "${city}" in my region database.`,
        );
      }

      try {
        const response = await axios.get(
          `https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${wilayah.kode}`,
        );

        // console.log(response.data.data[0].cuaca);
        const forecasts = response.data.data[0].cuaca; // flatten nested arrays
        if (!forecasts || forecasts.length === 0) {
          return message.reply(`⚠️ No weather data found for ${city}.`);
        }

        // Sort forecasts by datetime
        forecasts.sort(
          (a, b) => new Date(a.local_datetime) - new Date(b.local_datetime),
        );

        // Find the current and next 3 forecasts
        const upcoming = forecasts.slice(0, 4);

        if (upcoming.length === 0) {
          return message.reply(`⚠️ No upcoming forecast data for ${city}.`);
        }

        const current = upcoming[0][0];
        console.log(current);
        const next3 = upcoming[0].slice(1, 5);

        const weatherEmbed = new EmbedBuilder()
          .setColor("#00BFFF")
          .setTitle(`🌤 Weather for ${wilayah.kelurahan}, ${wilayah.kab_kota}`)
          .setDescription(
            `**${current.weather_desc_en} (${current.weather_desc})**`,
          )
          .setThumbnail(`${current.image.replace(/ /g, "%20")}`)
          .addFields(
            {
              name: "🌡️ Temperature",
              value: `${current.t}°C`,
              inline: true,
            },
            {
              name: "💧 Humidity",
              value: `${current.hu}%`,
              inline: true,
            },
            {
              name: "🌬️ Wind",
              value: `${current.ws} m/s (${current.wd})`,
              inline: true,
            },
            {
              name: "🕒 Forecast Time",
              value: new Date(current.local_datetime).toLocaleString("id-ID"),
              inline: false,
            },
            {
              name: "📈 Visibility",
              value: current.vs_text || "> 10 km",
              inline: true,
            },
            {
              name: "📅 Data Updated",
              value: new Date(current.analysis_date).toLocaleString("id-ID"),
              inline: true,
            },
            {
              name: `🔮 Next ${next3.length} Forecasts`,
              value: next3
                .map(
                  (f) =>
                    `🕒 **${new Date(f.local_datetime).toLocaleTimeString(
                      "id-ID",
                      {
                        hour: "2-digit",
                        minute: "2-digit",
                      },
                    )}** — ${f.weather_desc} (${f.t}°C, 💧${f.hu}%)`,
                )
                .join("\n"),
              inline: false,
            },
          )
          .setFooter({
            text: "Data source: BMKG | Kingdom of Science",
            iconURL:
              "https://api-apps.bmkg.go.id/storage/icon/cuaca/cerah-pm.svg",
          })
          .setTimestamp();

        message.channel.send({ embeds: [weatherEmbed] });
      } catch (err) {
        console.error("❌ Weather fetch error:", err.message);
        message.reply("⚠️ Failed to fetch weather data from BMKG.");
      }
      break;
    case "weatheralert":
      const items = await earlyWarning();

      // items.forEach(async (e) => {
      //   const alertEmbed = new EmbedBuilder()
      //     .setColor("#ffcc00")
      //     .setTitle(`⚠️ ${e.title}`)
      //     .setURL(e.link)
      //     .setDescription(e.description)
      //     .setImage(e.imgActualLink)
      //     .setFooter({ text: `valid: ${e.effective} sampai: ${e.expired}` });
      //
      //   await message.channel.send({
      //     embeds: [alertEmbed],
      //   });
      // });
      let index = 0;
      const generateEmbed = (i) => {
        const firstItem = items[i];

        return new EmbedBuilder()
          .setColor("#ffcc00")
          .setTitle(`⚠️ ${firstItem.title}`)
          .setURL(firstItem.link)
          .setDescription(firstItem.description)
          .setImage(firstItem.imgActualLink)
          .setFooter({
            text: `valid: ${firstItem.effective} sampai: ${firstItem.expired} | ${
              i + 1
            }/${items.length + 1}`,
          });
      };

      // Button
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("prev_alert")
          .setLabel("⬅️ Sebelumnya")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("next_alert")
          .setLabel("Berikutnya ➡️")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(items.length <= 1),
      );
      // Send message with button
      const sent = await message.channel.send({
        embeds: [generateEmbed(index)],
        components: [row],
      });

      const collector = sent.createMessageComponentCollector({
        filter: (i) => ["prev_alert", "next_alert"].includes(i.customId),
        time: 120_000, // 2 minutes
      });

      collector.on("collect", async (i) => {
        await i.deferUpdate();

        if (i.customId === "next_alert" && index <= items.length - 1) index++;
        else if (i.customId === "prev_alert" && index > 0) index--;

        // Update button states
        const newRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("prev_alert")
            .setLabel("⬅️ Sebelumnya")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(index === 0),
          new ButtonBuilder()
            .setCustomId("next_alert")
            .setLabel("Berikutnya ➡️")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(index === items.length - 1),
        );

        await sent.edit({
          embeds: [generateEmbed(index)],
          components: [newRow],
        });
      });

      collector.on("end", () => {
        // Disable buttons after time out
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("prev_alert")
            .setLabel("⬅️ Sebelumnya")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId("next_alert")
            .setLabel("Berikutnya ➡️")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true),
        );

        sent.edit({ components: [disabledRow] }).catch(() => {});
      });
      break;
    case "askai":
      if (args.length === 0) {
        return message.reply(
          "💬 Please ask me something, e.g. `!askai Why does Jakarta flood often?`",
        );
      }
      const prompt = args.join(" ");
      message.channel.send("🤖 Thinking with science...");
      const aiResponse = await askAI(prompt);
      console.log(aiResponse);

      // Try to parse header in the form: '<call_flag> <intent> <location>;' e.g. '1 rain Jakarta Selatan;'
      let header = null;
      let body = aiResponse;
      const headerRegex = /^([01])\s+(\S+)\s+([^;]+);/m;
      const m = aiResponse.match(headerRegex);
      if (m) {
        header = {
          callFlag: m[1],
          intent: m[2],
          location: m[3].trim(),
        };

        // remove header line (everything up to and including the first semicolon)
        const idx = aiResponse.indexOf(";") + 1;
        body = aiResponse.slice(idx).trim();
      }

      // CLI debug: show what the AI header parsed as (or none)
      if (header) {
        console.log("🧾 Parsed AI header:", header);
      } else {
        console.log("🧾 No AI header found in response.");
      }

      // If header instructs to call BMKG (callFlag === '1'), try to fetch and display weather for the location
      if (header && header.callFlag === "1") {
        try {
          const wilayah = findWilayahCode(header.location || "jakarta");
          if (!wilayah) {
            await message.channel.send(
              `⚠️ I couldn't find the location '${header.location}'. Showing AI response only.`,
            );
          } else {
            const response = await axios.get(
              `https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${wilayah.kode}`,
            );
            const forecasts = response.data.data[0].cuaca;
            if (forecasts && forecasts.length > 0) {
              const current = forecasts[0][0];
              const next3 = forecasts[0].slice(1, 5);

              const weatherEmbed = new EmbedBuilder()
                .setColor("#00BFFF")
                .setTitle(`🌤 Weather for ${wilayah.kelurahan}, ${wilayah.kab_kota}`)
                .setDescription(`**${current.weather_desc_en} (${current.weather_desc})**`)
                .setThumbnail(`${current.image.replace(/ /g, "%20")}`)
                .addFields(
                  {
                    name: "🌡️ Temperature",
                    value: `${current.t}°C`,
                    inline: true,
                  },
                  {
                    name: "💧 Humidity",
                    value: `${current.hu}%`,
                    inline: true,
                  },
                  {
                    name: "🌬️ Wind",
                    value: `${current.ws} m/s (${current.wd})`,
                    inline: true,
                  },
                  {
                    name: "🕒 Forecast Time",
                    value: new Date(current.local_datetime).toLocaleString("id-ID"),
                    inline: false,
                  },
                  {
                    name: `🔮 Next ${next3.length} Forecasts`,
                    value: next3
                      .map(
                        (f) =>
                          `🕒 **${new Date(f.local_datetime).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}** — ${f.weather_desc} (${f.t}°C, 💧${f.hu}%)`,
                      )
                      .join("\n"),
                    inline: false,
                  },
                )
                .setFooter({
                  text: "Data source: BMKG | Kingdom of Science",
                  iconURL: "https://api-apps.bmkg.go.id/storage/icon/cuaca/cerah-pm.svg",
                })
                .setTimestamp();

              await message.channel.send({ embeds: [weatherEmbed] });
            } else {
              await message.channel.send(`⚠️ No weather data found for ${header.location}.`);
            }
          }
        } catch (err) {
          console.error("❌ Weather fetch error (from askai header):", err.message);
          await message.channel.send("⚠️ Failed to fetch weather data from BMKG.");
        }
      }

      // Finally, send the AI body (use long-message split if necessary)
      if (body.length > 1800) {
        sendLongMessage(message.channel, `💬 **AI (truncated to fit Discord limits):** ${body}`);
      } else {
        message.channel.send(`💬 **AI:** ${body}`);
      }
      break;

    case "fact":
      if (facts.length === 0) {
        return message.reply("⚙️ No facts available yet.");
      }
      const randomFact = facts[Math.floor(Math.random() * facts.length)];
      message.channel.send(`📘 **Science Fact:** ${randomFact}`);
      break;

    case "drstone":
      const quote = quotes[Math.floor(Math.random() * quotes.length)];
      message.channel.send(`🎌 ${quote}`);
      break;

    case "self-destruct":
      //! we'll gonna do something here later
      break;

    default:
      message.reply("⚙️ Unknown command. Try `!help`.");
  }
});

client.login(process.env.DISCORD_TOKEN);
