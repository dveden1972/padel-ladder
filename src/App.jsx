import React, { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Trash2, Shuffle, Trophy, Users, X, Check, RotateCcw, UserPlus, Link2, Lock, Unlock, Download, Upload, Calendar, Clock, ChevronDown } from "lucide-react";

const FONT_STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');

/* Mobiel-vriendelijke basis: zonder box-sizing: border-box tellen padding en
   border bij de opgegeven breedte op, waardoor velden/knoppen met width:100%
   net buiten hun vak vallen — op een smal telefoonscherm valt dat meteen op
   als een scheve uitlijning of lichte horizontale overflow. */
*, *::before, *::after {
  box-sizing: border-box;
}
html, body {
  margin: 0;
  padding: 0;
  max-width: 100%;
  overflow-x: hidden;
}
input, select, textarea, button {
  max-width: 100%;
}
/* Zonder deze regel erven <button>/<input>/<select>/<textarea> de tekstkleur
   NIET automatisch over van hun ouder-element (de browser gebruikt dan een
   eigen systeemkleur, meestal zwart) — ze blijven op de lichte paginatekst
   vertrouwen zonder dat expliciet te zijn. */
button, input, select, textarea {
  color: inherit;
  font: inherit;
}
`;


const COURTS = 3;
// v2 keys: schema changed to individual players (name + email) instead of a free-text duo name
const STORAGE_KEY_PLAYERS = "padel-players-v2";
const STORAGE_KEY_DUOS = "padel-duos-v2";
const STORAGE_KEY_HISTORY = "padel-history-v2";
const STORAGE_KEY_CURRENT = "padel-current-round-v1"; // legacy: bevatte precies 1 ronde-object
const STORAGE_KEY_ROUNDS = "padel-rounds-v1"; // nieuw: array van rondes, meerdere tegelijk mogelijk
const STORAGE_KEY_ROUND_INFO = "padel-round-info-v1";
const ROUND_INTERVAL_DAYS = 14; // per 2 weken mag er 1 nieuwe ronde gepland worden

// Beheerderscode om e-mailadressen zichtbaar te maken. Verander deze naar wens.
// Dit is alleen bedoeld om e-mailadressen niet standaard voor iedereen zichtbaar
// te maken, niet als echte beveiliging (de code staat in deze code zelf).
const ADMIN_CODE = "tcl-beheer";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function normEmail(email) {
  return email.trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function pairKey(a, b) {
  return [a, b].sort().join("::");
}

// ISO 8601 weeknummer (zoals de Nederlandse "weeknummer"-conventie) voor een datum
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = (d - firstThursday) / 86400000;
  return 1 + Math.round(diff / 7);
}

// Aantal weken geleden dat dit duo-paar tegen elkaar speelde, gebaseerd op de
// echte verstreken tijd sinds die wedstrijd (niet op een handmatige teller).
function weeksSincePlayed(history, a, b, now) {
  const key = pairKey(a, b);
  let lastDate = null;
  for (const w of history) {
    if (pairKey(w.duoAId, w.duoBId) === key) {
      const d = new Date(w.date);
      if (!lastDate || d > lastDate) lastDate = d;
    }
  }
  if (!lastDate) return Infinity;
  const days = Math.round((now - lastDate) / (1000 * 60 * 60 * 24));
  return Math.max(0, Math.round(days / 7));
}

// Winpercentage van een duo op basis van alle eerder gespeelde en vastgelegde
// wedstrijden. Een duo dat nog niet heeft gespeeld krijgt 0.5 (neutraal) mee.
function winRate(duo) {
  if (!duo) return 0.5;
  const total = duo.wins + duo.losses;
  return total === 0 ? 0.5 : duo.wins / total;
}

// Bepaalt hoe goed een bepaalde koppeling van duo's is (hoe hoger, hoe beter):
// 1) Ranglijst-nabijheid weegt het zwaarst — duo's die dicht bij elkaar op de
//    ladder staan, komen bij voorkeur tegen elkaar te spelen, net als bij een
//    echte ladder-competitie waar de top elkaar het vaakst treft.
// 2) Vorm op basis van eerdere uitslagen: duo's met een vergelijkbaar
//    winpercentage leveren een eerlijkere, spannendere wedstrijd op — ook als
//    hun ladderpositie dat verschil nog niet volledig laat zien.
// 3) Afwisseling: hetzelfde duo-koppel speelt liever niet steeds weer tegen
//    elkaar; hoe langer geleden (of nooit) ze tegen elkaar speelden, hoe beter.
function scorePairing(pairs, duoLookup, history, now) {
  let score = 0;
  for (const [a, b] of pairs) {
    const duoA = duoLookup.get(a);
    const duoB = duoLookup.get(b);

    const posGap = Math.abs((duoA?.position ?? 0) - (duoB?.position ?? 0));
    score += Math.max(0, 30 - posGap * 4);

    const wrGap = Math.abs(winRate(duoA) - winRate(duoB));
    score += Math.max(0, 15 - wrGap * 15);

    const gap = weeksSincePlayed(history, a, b, now);
    if (gap === 0) score -= 60; // speelden nog maar net tegen elkaar: sterk vermijden
    else if (gap === Infinity) score += 10; // nog nooit tegen elkaar gespeeld: kleine bonus
    else score += Math.min(gap, 10);
  }
  return score;
}

function allPairings(ids) {
  if (ids.length === 0) return [[]];
  if (ids.length % 2 !== 0) return [];
  const [first, ...rest] = ids;
  const results = [];
  for (let i = 0; i < rest.length; i++) {
    const partner = rest[i];
    const remaining = rest.filter((_, idx) => idx !== i);
    const subPairings = allPairings(remaining);
    for (const sp of subPairings) {
      results.push([[first, partner], ...sp]);
    }
  }
  return results;
}

// Herberekent de volledige ladderstand (positie, wins, losses, gespeelde
// wedstrijden) door alle geschiedenis-uitslagen in RONDE-volgorde toe te passen
// — dus op basis van het rondenummer van de wedstrijd, niet de volgorde waarin
// de uitslag is ingevoerd. Dit is nodig zodra er wedstrijden uit meerdere
// rondes tegelijk open kunnen staan: als een latere ronde toevallig eerder
// wordt afgerond dan een eerdere, moet de ladder alsnog hetzelfde resultaat
// opleveren alsof alles keurig op rondevolgorde was verwerkt. Binnen dezelfde
// ronde geldt de invoervolgorde (op datum) als stabiele, voorspelbare tie-break.
function computeLadderFromHistory(duosList, historyList) {
  const position = new Map();
  const wins = new Map();
  const losses = new Map();
  const played = new Map();
  duosList.forEach((d) => {
    // initialPosition is de vaste "ankerpositie" bij aanmaak van het duo; oudere
    // duo's die dit veld nog niet hebben, vallen terug op hun huidige positie.
    position.set(d.id, d.initialPosition ?? d.position);
    wins.set(d.id, 0);
    losses.set(d.id, 0);
    played.set(d.id, 0);
  });

  const ordered = [...historyList].sort((a, b) => {
    const ra = a.round ?? Infinity;
    const rb = b.round ?? Infinity;
    if (ra !== rb) return ra - rb;
    return new Date(a.date) - new Date(b.date);
  });

  for (const entry of ordered) {
    const winnerId = entry.winnerId;
    const loserId = entry.duoAId === winnerId ? entry.duoBId : entry.duoAId;
    if (!position.has(winnerId) || !position.has(loserId)) continue; // duo inmiddels verwijderd
    wins.set(winnerId, wins.get(winnerId) + 1);
    played.set(winnerId, played.get(winnerId) + 1);
    losses.set(loserId, losses.get(loserId) + 1);
    played.set(loserId, played.get(loserId) + 1);

    const wPos = position.get(winnerId);
    const lPos = position.get(loserId);
    if (wPos > lPos) {
      position.set(winnerId, lPos);
      position.set(loserId, wPos);
    }
  }

  return duosList.map((d) => ({
    ...d,
    position: position.get(d.id),
    wins: wins.get(d.id),
    losses: losses.get(d.id),
    matchesPlayed: played.get(d.id),
  }));
}

// Zet een ISO-datetime om naar de waarde die een <input type="datetime-local">
// verwacht (lokale tijd, geen tijdzone-suffix).
function pad2(n) {
  return String(n).padStart(2, "0");
}

// "YYYY-MM-DD" in lokale tijd, voor het <input type="date"> veld
function toDatePart(date) {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// "HH:mm" in lokale tijd, voor de kwartier-tijdselector
function toTimePart(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Combineert een datum- en tijd-string tot een ISO-datetime. Geeft null terug
// zolang niet beide bekend zijn.
function combineDateTime(datePart, timePart) {
  if (!datePart || !timePart) return null;
  const d = new Date(`${datePart}T${timePart}:00`);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Alle kwartier-tijdstippen van een dag: 00:00, 00:15, 00:30 ... 23:45
// Kwartier-tijdstippen tussen 08:00 en 23:00 (inclusief), de speeluren van de club
const TIME_OPTIONS = (() => {
  const opts = [];
  for (let h = 8; h <= 23; h++) {
    const maxMinute = h === 23 ? 0 : 45; // laatste optie is 23:00, niet later
    for (let m = 0; m <= maxMinute; m += 15) {
      opts.push(`${pad2(h)}:${pad2(m)}`);
    }
  }
  return opts;
})();

// Nederlandse weergave van datum + tijd, bijv. "ma 28 jul · 18:00"
function formatMatchDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const datePart = d.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" });
  const timePart = d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  return `${datePart} · ${timePart}`;
}

// "dd/mm/yyyy", voor de dag-koppen in de Agenda
function formatDateDMY(dateOrIso) {
  const d = typeof dateOrIso === "string" ? new Date(dateOrIso) : dateOrIso;
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export default function PadelLadder() {
  const [players, setPlayers] = useState([]); // {id, name, email}
  const [duos, setDuos] = useState([]); // {id, playerIds:[a,b], wins, losses, matchesPlayed, position}
  const [history, setHistory] = useState([]);
  const [now] = useState(() => new Date());
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("ladder");
  const [duoFilter, setDuoFilter] = useState(""); // duo-id; "" = alle duo's (gebruikt in Open & Agenda)
  const [isAdmin, setIsAdmin] = useState(false); // session-only, niet opgeslagen
  const [showAdminForm, setShowAdminForm] = useState(false);
  const [adminInput, setAdminInput] = useState("");
  const fileInputRef = useRef(null);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newPlayerEmail, setNewPlayerEmail] = useState("");
  const [duoPlayerA, setDuoPlayerA] = useState("");
  const [duoPlayerB, setDuoPlayerB] = useState("");
  const [rounds, setRounds] = useState([]); // persisted: [{ roundNumber, generatedAt, matches: [...], restDuoIds: [...] }, ...]
  const [roundInfo, setRoundInfo] = useState(null); // persisted: { lastRoundNumber, lastGeneratedAt }
  const [error, setError] = useState("");
  const [scoreEntry, setScoreEntry] = useState({}); // { [matchId]: { winnerId, loserId, scoreWinner, scoreLoser } }
  const [scheduleDraft, setScheduleDraft] = useState({}); // { [matchId]: { date, time } } — nog niet bevestigde planning
  const [expandedDuoId, setExpandedDuoId] = useState(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [pendingImport, setPendingImport] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await window.storage.get(STORAGE_KEY_PLAYERS, true);
        setPlayers(p ? JSON.parse(p.value) : []);
      } catch {
        setPlayers([]);
      }
      try {
        const d = await window.storage.get(STORAGE_KEY_DUOS, true);
        setDuos(d ? JSON.parse(d.value) : []);
      } catch {
        setDuos([]);
      }
      try {
        const h = await window.storage.get(STORAGE_KEY_HISTORY, true);
        setHistory(h ? JSON.parse(h.value) : []);
      } catch {
        setHistory([]);
      }
      try {
        const r = await window.storage.get(STORAGE_KEY_ROUNDS, true);
        if (r) {
          setRounds(JSON.parse(r.value) || []);
        } else {
          // Eenmalige migratie vanaf de oude opzet (precies 1 actieve ronde).
          let legacy = null;
          try {
            legacy = await window.storage.get(STORAGE_KEY_CURRENT, true);
          } catch {
            legacy = null;
          }
          if (legacy) {
            const legacyRound = JSON.parse(legacy.value);
            const migrated = legacyRound
              ? [
                  {
                    ...legacyRound,
                    matches: legacyRound.matches.map((m) => ({
                      ...m,
                      roundNumber: m.roundNumber ?? legacyRound.roundNumber,
                    })),
                  },
                ]
              : [];
            setRounds(migrated);
            if (migrated.length > 0) {
              try {
                await window.storage.set(STORAGE_KEY_ROUNDS, JSON.stringify(migrated), true);
              } catch {
                // niet erg, wordt bij de volgende wijziging alsnog opgeslagen
              }
            }
          } else {
            setRounds([]);
          }
        }
      } catch {
        setRounds([]);
      }
      try {
        const r = await window.storage.get(STORAGE_KEY_ROUND_INFO, true);
        setRoundInfo(r ? JSON.parse(r.value) : null);
      } catch {
        setRoundInfo(null);
      }
      setLoaded(true);
    })();
  }, []);

  const persistPlayers = useCallback(async (next) => {
    setPlayers(next);
    try {
      await window.storage.set(STORAGE_KEY_PLAYERS, JSON.stringify(next), true);
    } catch {
      setError("Opslaan is niet gelukt. Probeer het opnieuw.");
    }
  }, []);

  const persistDuos = useCallback(async (next) => {
    setDuos(next);
    try {
      await window.storage.set(STORAGE_KEY_DUOS, JSON.stringify(next), true);
    } catch {
      setError("Opslaan is niet gelukt. Probeer het opnieuw.");
    }
  }, []);

  const persistHistory = useCallback(async (next) => {
    setHistory(next);
    try {
      await window.storage.set(STORAGE_KEY_HISTORY, JSON.stringify(next), true);
    } catch {
      setError("Opslaan is niet gelukt. Probeer het opnieuw.");
    }
  }, []);

  const persistRounds = useCallback(async (next) => {
    setRounds(next);
    try {
      if (!next || next.length === 0) {
        try {
          await window.storage.delete(STORAGE_KEY_ROUNDS, true);
        } catch {
          // key mogelijk al afwezig, geen probleem
        }
      } else {
        await window.storage.set(STORAGE_KEY_ROUNDS, JSON.stringify(next), true);
      }
    } catch {
      setError("Opslaan is niet gelukt. Probeer het opnieuw.");
    }
  }, []);

  const persistRoundInfo = useCallback(async (next) => {
    setRoundInfo(next);
    try {
      await window.storage.set(STORAGE_KEY_ROUND_INFO, JSON.stringify(next), true);
    } catch {
      setError("Opslaan is niet gelukt. Probeer het opnieuw.");
    }
  }, []);


  function playerById(id) {
    return players.find((p) => p.id === id);
  }

  function duoName(duo) {
    if (!duo) return "";
    const names = duo.playerIds.map((id) => playerById(id)?.name || "?");
    return names.join(" & ");
  }

  function maskEmail(email) {
    const at = email.indexOf("@");
    if (at <= 0) return "•••••";
    const local = email.slice(0, at);
    const domain = email.slice(at);
    const visible = local.slice(0, 1);
    return `${visible}${"•".repeat(Math.max(3, local.length - 1))}${domain}`;
  }

  function unlockAdmin() {
    if (adminInput.trim().toLowerCase() === ADMIN_CODE.trim().toLowerCase()) {
      setIsAdmin(true);
      setShowAdminForm(false);
      setAdminInput("");
      setError("");
    } else {
      setError("Onjuiste beheerderscode.");
    }
  }

  // Voegt 4 demo-duo's (8 spelers) toe, handig om de app snel uit te proberen.
  // Slaat spelers over waarvan het e-mailadres al bestaat, zodat dit veilig
  // meerdere keren geklikt kan worden zonder dubbele foutmeldingen.
  async function addDemoData() {
    const demoPeople = [
      { name: "Sander Bakker", email: "sander.bakker@voorbeeld.nl" },
      { name: "Femke de Groot", email: "femke.degroot@voorbeeld.nl" },
      { name: "Tim Jansen", email: "tim.jansen@voorbeeld.nl" },
      { name: "Lisa van Dijk", email: "lisa.vandijk@voorbeeld.nl" },
      { name: "Bram Visser", email: "bram.visser@voorbeeld.nl" },
      { name: "Anne Smit", email: "anne.smit@voorbeeld.nl" },
      { name: "Kevin de Wit", email: "kevin.dewit@voorbeeld.nl" },
      { name: "Sophie Mulder", email: "sophie.mulder@voorbeeld.nl" },
      { name: "Daan Hendriks", email: "daan.hendriks@voorbeeld.nl" },
      { name: "Eva Peters", email: "eva.peters@voorbeeld.nl" },
      { name: "Thijs Bos", email: "thijs.bos@voorbeeld.nl" },
      { name: "Nina de Boer", email: "nina.deboer@voorbeeld.nl" },
      { name: "Ruben van Leeuwen", email: "ruben.vanleeuwen@voorbeeld.nl" },
      { name: "Julia Willems", email: "julia.willems@voorbeeld.nl" },
      { name: "Milan Dekker", email: "milan.dekker@voorbeeld.nl" },
      { name: "Sanne Kuipers", email: "sanne.kuipers@voorbeeld.nl" },
    ];

    const existingEmails = new Set(players.map((p) => normEmail(p.email)));
    const newPeople = demoPeople.filter((p) => !existingEmails.has(normEmail(p.email)));
    const newPlayers = newPeople.map((p) => ({ id: uid(), name: p.name, email: p.email }));
    const allPlayers = [...players, ...newPlayers];

    // Zoek voor elke demo-persoon de bijbehorende speler-id terug (bestaand of nieuw)
    const idFor = (email) =>
      allPlayers.find((p) => normEmail(p.email) === normEmail(email))?.id;

    const demoDuoPairs = [
      ["sander.bakker@voorbeeld.nl", "femke.degroot@voorbeeld.nl"],
      ["tim.jansen@voorbeeld.nl", "lisa.vandijk@voorbeeld.nl"],
      ["bram.visser@voorbeeld.nl", "anne.smit@voorbeeld.nl"],
      ["kevin.dewit@voorbeeld.nl", "sophie.mulder@voorbeeld.nl"],
      ["daan.hendriks@voorbeeld.nl", "eva.peters@voorbeeld.nl"],
      ["thijs.bos@voorbeeld.nl", "nina.deboer@voorbeeld.nl"],
      ["ruben.vanleeuwen@voorbeeld.nl", "julia.willems@voorbeeld.nl"],
      ["milan.dekker@voorbeeld.nl", "sanne.kuipers@voorbeeld.nl"],
    ];

    const alreadyAssigned = assignedPlayerIds();
    let nextPosition = duos.length + 1;
    const newDuos = [];
    for (const [emailA, emailB] of demoDuoPairs) {
      const idA = idFor(emailA);
      const idB = idFor(emailB);
      if (!idA || !idB) continue;
      if (alreadyAssigned.has(idA) || alreadyAssigned.has(idB)) continue;
      newDuos.push({
        id: uid(),
        playerIds: [idA, idB],
        wins: 0,
        losses: 0,
        matchesPlayed: 0,
        position: nextPosition,
        initialPosition: nextPosition,
        paused: false,
      });
      nextPosition++;
    }

    if (newPlayers.length === 0 && newDuos.length === 0) {
      setError("De demo-data staat er al in.");
      return;
    }
    setError("");
    await persistPlayers(allPlayers);
    await persistDuos([...duos, ...newDuos]);
  }

  // Players already assigned to an existing duo
  function assignedPlayerIds() {
    const set = new Set();
    duos.forEach((d) => d.playerIds.forEach((id) => set.add(id)));
    return set;
  }

  function addPlayer() {
    const name = newPlayerName.trim();
    const email = newPlayerEmail.trim();
    if (!name || !email) {
      setError("Vul zowel een naam als een e-mailadres in.");
      return;
    }
    if (!isValidEmail(email)) {
      setError("Vul een geldig e-mailadres in.");
      return;
    }
    const emailN = normEmail(email);
    const nameN = name.toLowerCase();
    const duplicate = players.some(
      (p) => normEmail(p.email) === emailN && p.name.toLowerCase() === nameN
    );
    if (duplicate) {
      setError("Deze naam met dit e-mailadres staat al in de lijst.");
      return;
    }
    const emailUsed = players.some((p) => normEmail(p.email) === emailN);
    if (emailUsed) {
      setError("Dit e-mailadres is al gekoppeld aan een andere naam.");
      return;
    }
    setError("");
    persistPlayers([...players, { id: uid(), name, email }]);
    setNewPlayerName("");
    setNewPlayerEmail("");
  }

  // Een duo mag niet meer verwijderd worden zolang het ergens in een open
  // ronde voorkomt — ook niet als de wedstrijd al gespeeld (status "done") of
  // geannuleerd is, en ook niet als het om een oudere ronde gaat die nog
  // naast een nieuwere openstaat. Die wedstrijd blijft namelijk in de Agenda
  // staan (met datum en eventueel uitslag) totdat de bijbehorende ronde
  // vervangen wordt, en heeft dus nog steeds een geldig duo nodig om te tonen.
  function duoHasScheduledMatch(duoId) {
    return rounds.some((round) =>
      round.matches.some((m) => m.duoAId === duoId || m.duoBId === duoId)
    );
  }

  async function removePlayer(id) {
    if (!isAdmin) {
      setError("Alleen de beheerder kan spelers verwijderen.");
      return;
    }
    const duo = duos.find((d) => d.playerIds.includes(id));
    if (duo && duoHasScheduledMatch(duo.id)) {
      setError(
        "Deze speler zit in een duo dat wedstrijden heeft staan in de Agenda en kan daarom niet verwijderd worden."
      );
      return;
    }
    const inDuo = !!duo;
    if (inDuo) {
      // Cascade: remove the duo this player belongs to as well
      const nextDuos = duos
        .filter((d) => !d.playerIds.includes(id))
        .sort((a, b) => a.position - b.position)
        .map((d, i) => ({ ...d, position: i + 1 }));
      await persistDuos(nextDuos);
    }
    await persistPlayers(players.filter((p) => p.id !== id));
  }

  function addDuo() {
    if (!duoPlayerA || !duoPlayerB) {
      setError("Kies twee spelers om een duo te vormen.");
      return;
    }
    if (duoPlayerA === duoPlayerB) {
      setError("Kies twee verschillende spelers.");
      return;
    }
    const assigned = assignedPlayerIds();
    if (assigned.has(duoPlayerA) || assigned.has(duoPlayerB)) {
      setError("Een van deze spelers zit al in een ander duo.");
      return;
    }
    setError("");
    const next = [
      ...duos,
      {
        id: uid(),
        playerIds: [duoPlayerA, duoPlayerB],
        wins: 0,
        losses: 0,
        matchesPlayed: 0,
        position: duos.length + 1,
        initialPosition: duos.length + 1,
        paused: false,
      },
    ];
    persistDuos(next);
    setDuoPlayerA("");
    setDuoPlayerB("");
  }

  function removeDuo(id) {
    if (!isAdmin) {
      setError("Alleen de beheerder kan duo's verwijderen.");
      return;
    }
    if (duoHasScheduledMatch(id)) {
      setError(
        "Dit duo heeft wedstrijden staan in de Agenda en kan daarom niet verwijderd worden."
      );
      return;
    }
    const next = duos
      .filter((d) => d.id !== id)
      .sort((a, b) => a.position - b.position)
      .map((d, i) => ({ ...d, position: i + 1 }));
    persistDuos(next);
  }

  // Een duo op pauze zet zichzelf buiten de ronde-generatie: ze worden niet
  // meer automatisch ingepland totdat de pauze weer wordt opgeheven. Dit mag
  // door iedereen ingesteld worden (geen beheerdersrecht) en heeft geen effect
  // op een al lopende ronde — alleen op de eerstvolgende die gegenereerd wordt.
  function togglePauseDuo(id) {
    const next = duos.map((d) => (d.id === id ? { ...d, paused: !d.paused } : d));
    persistDuos(next);
  }

  // De meest recent gegenereerde ronde (indien aanwezig). Dit is de enige
  // ronde waar nog niet-ingeplande wedstrijden in kunnen zitten: elke ronde
  // moest namelijk al volledig ingepland zijn vóórdat de erna gegenereerd kon
  // worden (zie latestRoundFullyScheduled hieronder).
  const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
  // Alle wedstrijden uit alle open rondes samen — gebruikt voor de Agenda,
  // baanconflict-checks en de "mag dit duo verwijderd worden"-check.
  const allMatches = rounds.flatMap((r) => r.matches);

  // Een nieuwe ronde mag pas gegenereerd worden als de laatst gegenereerde
  // ronde volledig is INGEPLAND (elke wedstrijd heeft een baan én een datum/
  // tijd) — niet per se al afgerond. Zo kunnen er dus wedstrijden uit meerdere
  // rondes tegelijk in de Agenda staan, bijvoorbeeld omdat een wedstrijd uit
  // een eerdere ronde nog niet gespeeld is terwijl de volgende ronde er al is.
  const latestRoundFullyScheduled =
    !latestRound || latestRound.matches.every((m) => m.court && m.scheduledAt);

  // Per 2 weken (14 dagen) mag er normaal 1 nieuwe ronde gegenereerd worden. Een
  // individuele wedstrijd mag wel verder in de toekomst gepland worden (bijv.
  // over 3 weken) — deze grens gaat alleen over hoe vaak er een nieuwe ronde bij
  // mag komen. De beheerder mag deze limiet altijd omzeilen (zoals al kon).
  const daysSinceLastRound = roundInfo?.lastGeneratedAt
    ? Math.floor((now - new Date(roundInfo.lastGeneratedAt)) / (1000 * 60 * 60 * 24))
    : null;
  const daysUntilNextRound =
    daysSinceLastRound === null ? 0 : Math.max(0, ROUND_INTERVAL_DAYS - daysSinceLastRound);
  const roundLimitReached = daysUntilNextRound > 0;
  const nextRoundNumber = (roundInfo?.lastRoundNumber || 0) + 1;

  async function generateProposal() {
    if (!isAdmin) {
      setError("Alleen de beheerder kan een nieuwe ronde genereren.");
      return;
    }
    if (!latestRoundFullyScheduled) {
      setError(
        `Ronde ${latestRound.roundNumber} moet eerst volledig ingepland zijn (elke wedstrijd een baan en een datum/tijd) voordat er een nieuwe ronde gegenereerd kan worden.`
      );
      return;
    }
    if (duos.length < 2) {
      setError("Stel minstens 2 duo's samen om wedstrijden voor te stellen.");
      return;
    }
    const pausedDuos = duos.filter((d) => d.paused);
    const activeDuos = duos.filter((d) => !d.paused);
    if (activeDuos.length < 2) {
      setError(
        "Er zijn minstens 2 niet-gepauzeerde duo's nodig om wedstrijden voor te stellen."
      );
      return;
    }
    setError("");
    // Elk actief (niet-gepauzeerd) duo speelt deze ronde mee. Alleen bij een
    // oneven aantal actieve duo's moet er noodgedwongen één duo overslaan —
    // dat duo krijgt voorrang bij de eerstvolgende ronde (minste wedstrijden
    // gespeeld, willekeurig bij gelijkspel).
    const sortedActive = [...activeDuos].sort((a, b) => {
      if (a.matchesPlayed !== b.matchesPlayed) return a.matchesPlayed - b.matchesPlayed;
      return Math.random() - 0.5;
    });
    const maxPlaying = sortedActive.length - (sortedActive.length % 2 === 0 ? 0 : 1);
    const playing = sortedActive.slice(0, maxPlaying).map((d) => d.id);
    const oddOneOut = sortedActive.slice(maxPlaying); // leeg, of precies 1 duo
    const resting = [...pausedDuos, ...oddOneOut];

    const candidates = allPairings(playing);
    const duoLookup = new Map(duos.map((d) => [d.id, d]));
    let best = null;
    let bestScore = -Infinity;
    for (const cand of candidates.slice(0, 2000)) {
      const s = scorePairing(cand, duoLookup, history, now);
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }
    const matches = (best || []).map(([a, b]) => ({
      id: uid(),
      roundNumber: nextRoundNumber,
      court: null, // door het duo zelf te kiezen — verplicht, geen standaardbaan
      duoAId: a,
      duoBId: b,
      status: "pending", // "pending" | "done" | "cancelled"
      winnerId: null,
      scheduledAt: null, // ISO datetime, door de duo's zelf in te plannen — ook verplicht
    }));
    const newRound = {
      roundNumber: nextRoundNumber,
      generatedAt: now.toISOString(),
      matches,
      restDuoIds: resting.map((d) => d.id),
    };
    await persistRounds([...rounds, newRound]);
    await persistRoundInfo({ lastRoundNumber: nextRoundNumber, lastGeneratedAt: now.toISOString() });
  }

  function duoById(id) {
    return duos.find((d) => d.id === id);
  }

  function pairFreshness(a, b) {
    const gap = weeksSincePlayed(history, a, b, now);
    if (gap === Infinity) return { label: "Nieuwe combinatie", fresh: true };
    if (gap === 0) return { label: "Speelden deze week al", fresh: false };
    return { label: `${gap} ${gap === 1 ? "week" : "weken"} geleden gespeeld`, fresh: gap >= 3 };
  }

  // Zoekt de wedstrijd (en de ronde waar hij bij hoort) terug over alle open
  // rondes heen, zodat acties niet langer aannemen dat er maar 1 ronde is.
  function findRoundForMatch(matchId) {
    return rounds.find((round) => round.matches.some((m) => m.id === matchId)) || null;
  }

  // Past een wijziging toe op precies de wedstrijd met dit id, in welke ronde
  // die ook zit, en geeft de bijgewerkte rondes-array terug (nog niet opgeslagen).
  function updateMatchInRounds(matchId, updateFn) {
    return rounds.map((round) => {
      if (!round.matches.some((m) => m.id === matchId)) return round;
      return {
        ...round,
        matches: round.matches.map((m) => (m.id === matchId ? updateFn(m) : m)),
      };
    });
  }

  // Wijst een winnaar aan voor een wedstrijd. Dit ligt daarna vast: de wedstrijd
  // kan niet meer opnieuw gegenereerd of gewijzigd worden.
  async function recordResult(matchId, winnerId, loserId, scoreWinner, scoreLoser) {
    const matchRound = findRoundForMatch(matchId);

    const entry = {
      id: uid(),
      duoAId: winnerId,
      duoBId: loserId,
      winnerId,
      scoreWinner,
      scoreLoser,
      date: now.toISOString(),
      week: getISOWeek(now),
      round: matchRound?.roundNumber || null,
    };
    const nextHistory = [...history, entry];
    // Ladder-regel: win je van een duo dat BOVEN je stond (lager positienummer),
    // dan neem je hun plek over (en zij die van jou); verlies je van een duo dat
    // al onder je stond, dan verandert er niets. Omdat er nu wedstrijden uit
    // meerdere rondes tegelijk open kunnen staan, wordt de hele ladder opnieuw
    // berekend in RONDE-volgorde in plaats van gewoon deze ene wissel toe te
    // passen — zo maakt het niet uit of een latere ronde toevallig eerder wordt
    // afgerond dan een eerdere (zie computeLadderFromHistory hierboven).
    const nextDuos = computeLadderFromHistory(duos, nextHistory);

    const nextRounds = updateMatchInRounds(matchId, (m) => ({
      ...m,
      status: "done",
      winnerId,
      scoreWinner,
      scoreLoser,
    }));

    // Na elkaar opslaan (niet tegelijk) om de opslag-snelheidslimiet niet te raken.
    await persistDuos(nextDuos);
    await persistHistory(nextHistory);
    await persistRounds(nextRounds);
  }

  // Annuleert een wedstrijd: geen winnaar, geen invloed op de ladder. De
  // betrokken duo's tellen niet mee als "gespeeld" en komen dus eerder weer
  // in aanmerking bij de volgende ronde.
  function cancelMatch(matchId) {
    const nextRounds = updateMatchInRounds(matchId, (m) => ({ ...m, status: "cancelled" }));
    persistRounds(nextRounds);
  }

  // Stap 1: winnaar kiezen — toont daarna de invoervelden voor de stand.
  function chooseWinner(matchId, winnerId, loserId) {
    setScoreEntry((prev) => ({
      ...prev,
      [matchId]: { winnerId, loserId, scoreWinner: "", scoreLoser: "" },
    }));
  }

  function updateScoreEntry(matchId, field, value) {
    setScoreEntry((prev) => ({
      ...prev,
      [matchId]: { ...prev[matchId], [field]: value },
    }));
  }

  function cancelScoreEntry(matchId) {
    setScoreEntry((prev) => {
      const next = { ...prev };
      delete next[matchId];
      return next;
    });
  }

  // Stap 2: stand bevestigen — pas nu wordt de wedstrijd echt vastgelegd.
  function confirmScoreEntry(matchId) {
    const entry = scoreEntry[matchId];
    if (!entry) return;
    const scoreWinner = Number(entry.scoreWinner);
    const scoreLoser = Number(entry.scoreLoser);
    const isValid = (n) => Number.isInteger(n) && n >= 0 && n <= 30;
    if (entry.scoreWinner === "" || entry.scoreLoser === "" || !isValid(scoreWinner) || !isValid(scoreLoser)) {
      setError("Vul voor beide duo's een geldige stand in (een heel getal van 0 t/m 30).");
      return;
    }
    if (scoreWinner < scoreLoser) {
      setError("De winnaar kan niet een lagere stand hebben dan de verliezer.");
      return;
    }
    setError("");
    recordResult(matchId, entry.winnerId, entry.loserId, scoreWinner, scoreLoser);
    cancelScoreEntry(matchId);
  }

  // Legt vast wanneer een wedstrijd gespeeld gaat worden (of maakt dit weer leeg).
  function setMatchSchedule(matchId, isoDateTime) {
    const nextRounds = updateMatchInRounds(matchId, (m) => ({
      ...m,
      scheduledAt: isoDateTime || null,
    }));
    persistRounds(nextRounds);
  }

  // Geeft de (nog niet per se bevestigde) datum/tijd-selectie voor een wedstrijd terug.
  // Zolang er geen concept is, vallen we terug op de al opgeslagen planning.
  function getScheduleDraft(m) {
    return (
      scheduleDraft[m.id] || {
        date: toDatePart(m.scheduledAt),
        time: toTimePart(m.scheduledAt),
      }
    );
  }

  // Werkt de conceptdatum of -tijd bij zodra de gebruiker iets kiest, zonder dit
  // meteen op te slaan — zo blijft de selectie altijd zichtbaar in het formulier,
  // ook als alleen de datum (of alleen de tijd) al is gekozen.
  function updateScheduleDraft(m, field, value) {
    const current = getScheduleDraft(m);
    setScheduleDraft((prev) => ({ ...prev, [m.id]: { ...current, [field]: value } }));
  }

  // Slaat de conceptdatum/-tijd pas echt op zodra de gebruiker op "Bevestig" klikt.
  function confirmSchedule(m) {
    const draft = getScheduleDraft(m);
    const iso = combineDateTime(draft.date, draft.time);
    if (!iso) return;
    setMatchSchedule(m.id, iso);
  }

  // Laat het duo zelf de baan kiezen/wijzigen (baan 1, 2 of 3).
  function setMatchCourt(matchId, court) {
    const nextRounds = updateMatchInRounds(matchId, (m) => ({
      ...m,
      court: court ? Number(court) : null,
    }));
    persistRounds(nextRounds);
  }

  // Checkt of een andere openstaande wedstrijd (uit welke open ronde dan ook)
  // dezelfde baan én hetzelfde tijdstip heeft.
  function hasCourtConflict(match) {
    if (!match.scheduledAt || !match.court) return false;
    return allMatches.some(
      (m) =>
        m.id !== match.id &&
        m.status === "pending" &&
        m.court === match.court &&
        m.scheduledAt === match.scheduledAt
    );
  }

  const todayDatePart = toDatePart(now);

  // Eén kaart voor één wedstrijd: baan, datum/tijd en (indien gewenst) de acties.
  // Wordt gebruikt door zowel "Open" (nog niet ingepland, geen winnaar-knoppen) als
  // "Agenda" (wel ingepland, daar kun je ook de winnaar aanwijzen of annuleren).
  function renderMatchCard(m, { showResultButtons = true } = {}) {
    const duoA = duoById(m.duoAId);
    const duoB = duoById(m.duoBId);
    const fresh = pairFreshness(m.duoAId, m.duoBId);
    if (!duoA || !duoB) return null;
    const draft = getScheduleDraft(m);
    const courtMissing = !m.court;
    const dateMissing = !draft.date;
    const timeMissing = !draft.time;
    const draftIso = combineDateTime(draft.date, draft.time);
    const isConfirmed = !!draftIso && draftIso === m.scheduledAt;
    const canConfirm = draft.date && draft.time && !isConfirmed;

    return (
      <div key={m.id} style={styles.courtCard}>
        {m.roundNumber && <div style={styles.roundTag}>RONDE {m.roundNumber}</div>}
        <div style={styles.matchup}>
          <div style={styles.matchupDuo}>{duoName(duoA)}</div>
          <div style={styles.vs}>VS</div>
          <div style={styles.matchupDuo}>{duoName(duoB)}</div>
        </div>

        {m.status === "pending" && (
          <>
            <div
              style={{
                ...styles.freshTag,
                ...(fresh.fresh ? styles.freshTagGood : styles.freshTagNeutral),
              }}
            >
              {fresh.label}
            </div>

            <label style={styles.scheduleLabel}>1. Kies een baan (verplicht)</label>
            <div style={styles.courtSelectRow}>
              <select
                value={m.court || ""}
                onChange={(e) => setMatchCourt(m.id, e.target.value)}
                style={{
                  ...styles.courtSelect,
                  ...(courtMissing ? styles.fieldMissing : {}),
                }}
              >
                <option value="">Kies baan…</option>
                <option value={1}>Baan 1</option>
                <option value={2}>Baan 2</option>
                <option value={3}>Baan 3</option>
              </select>
              {hasCourtConflict(m) && <span style={styles.courtConflict}>dubbel geboekt</span>}
            </div>

            <label style={styles.scheduleLabel}>
              <Clock size={13} style={{ marginRight: 6 }} />
              2. Kies datum en tijd (verplicht)
            </label>
            <div style={styles.scheduleRow}>
              <input
                type="date"
                min={todayDatePart}
                value={draft.date}
                onChange={(e) => updateScheduleDraft(m, "date", e.target.value)}
                style={{
                  ...styles.scheduleDateInput,
                  ...(dateMissing ? styles.fieldMissing : {}),
                }}
              />
              <select
                value={draft.time}
                onChange={(e) => updateScheduleDraft(m, "time", e.target.value)}
                style={{
                  ...styles.scheduleTimeSelect,
                  ...(timeMissing ? styles.fieldMissing : {}),
                }}
              >
                <option value="">Kies tijd…</option>
                {TIME_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            {canConfirm && (
              <div style={styles.resultRow}>
                <button onClick={() => confirmSchedule(m)} style={styles.confirmScheduleBtn}>
                  <Check size={13} style={{ marginRight: 5 }} />
                  Bevestig datum & tijd
                </button>
              </div>
            )}
            {isConfirmed && (
              <div style={styles.scheduleConfirmedTag}>
                <Check size={12} style={{ marginRight: 5 }} />
                Ingepland: {formatMatchDateTime(m.scheduledAt)}
              </div>
            )}

            {showResultButtons && (
              <>
                {scoreEntry[m.id] ? (
                  <div style={styles.scoreEntryBox}>
                    <div style={styles.scoreEntryTitle}>
                      {duoName(duoById(scoreEntry[m.id].winnerId))} wint — wat was de stand?
                    </div>
                    <div style={styles.scoreRow}>
                      <div style={styles.scoreField}>
                        <label style={styles.scoreLabel}>
                          {duoName(duoById(scoreEntry[m.id].winnerId))}
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={30}
                          step={1}
                          value={scoreEntry[m.id].scoreWinner}
                          onChange={(e) => updateScoreEntry(m.id, "scoreWinner", e.target.value)}
                          style={styles.scoreInput}
                        />
                      </div>
                      <div style={styles.scoreField}>
                        <label style={styles.scoreLabel}>
                          {duoName(duoById(scoreEntry[m.id].loserId))}
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={30}
                          step={1}
                          value={scoreEntry[m.id].scoreLoser}
                          onChange={(e) => updateScoreEntry(m.id, "scoreLoser", e.target.value)}
                          style={styles.scoreInput}
                        />
                      </div>
                    </div>
                    <div style={styles.resultRow}>
                      <button onClick={() => confirmScoreEntry(m.id)} style={styles.winBtn}>
                        <Check size={13} style={{ marginRight: 5 }} />
                        Bevestig resultaat
                      </button>
                      <button
                        onClick={() => cancelScoreEntry(m.id)}
                        style={styles.cancelBtn}
                      >
                        <X size={13} style={{ marginRight: 5 }} />
                        Andere winnaar kiezen
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={styles.resultRow}>
                    <button
                      onClick={() => chooseWinner(m.id, duoA.id, duoB.id)}
                      style={styles.winBtn}
                    >
                      <Check size={13} style={{ marginRight: 5 }} />
                      {duoName(duoA)} wint
                    </button>
                    <button
                      onClick={() => chooseWinner(m.id, duoB.id, duoA.id)}
                      style={styles.winBtn}
                    >
                      <Check size={13} style={{ marginRight: 5 }} />
                      {duoName(duoB)} wint
                    </button>
                  </div>
                )}
              </>
            )}
            {!scoreEntry[m.id] && (
              <div style={styles.resultRow}>
                <button onClick={() => cancelMatch(m.id)} style={styles.cancelBtn}>
                  <X size={13} style={{ marginRight: 5 }} />
                  Wedstrijd annuleren
                </button>
              </div>
            )}
          </>
        )}

        {m.status === "done" && (
          <>
            <div style={styles.courtLabel}>BAAN {m.court}</div>
            <div style={styles.doneTag}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <Check size={13} style={{ marginRight: 6 }} />
                {duoName(duoById(m.winnerId))} wint
                {typeof m.scoreWinner === "number" && (
                  <span style={{ marginLeft: 6 }}>
                    ({m.scoreWinner}-{m.scoreLoser})
                  </span>
                )}
              </div>
              {m.scheduledAt && (
                <span style={styles.doneTagDate}>{formatMatchDateTime(m.scheduledAt)}</span>
              )}
            </div>
          </>
        )}

        {m.status === "cancelled" && (
          <>
            {m.court && <div style={styles.courtLabel}>BAAN {m.court}</div>}
            <div style={styles.cancelledTag}>
              <X size={13} style={{ marginRight: 6 }} />
              Wedstrijd geannuleerd
            </div>
          </>
        )}
      </div>
    );
  }

  // Groepeert de afgeronde wedstrijden (history) per kalenderweek, meest recent eerst.
  function groupHistoryByWeek(entries, maxWeeks) {
    const byWeek = new Map();
    for (const h of entries) {
      if (!byWeek.has(h.week)) byWeek.set(h.week, []);
      byWeek.get(h.week).push(h);
    }
    const weeks = Array.from(byWeek.keys()).sort((a, b) => b - a).slice(0, maxWeeks);
    return weeks.map((w) => ({ week: w, entries: byWeek.get(w) }));
  }

  // Geschiedenis van één duo: elke wedstrijd die het duo speelde, meest recente eerst,
  // met per wedstrijd het rondenummer, de tegenstander, win/verlies en de stand.
  function getDuoHistory(duoId) {
    return history
      .filter((h) => h.duoAId === duoId || h.duoBId === duoId)
      .map((h) => {
        const won = h.winnerId === duoId;
        const opponentId = h.duoAId === duoId ? h.duoBId : h.duoAId;
        const ownScore = won ? h.scoreWinner : h.scoreLoser;
        const oppScore = won ? h.scoreLoser : h.scoreWinner;
        return { ...h, won, opponentId, ownScore, oppScore };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  function exportData() {
    const payload = {
      exportedAt: new Date().toISOString(),
      players,
      duos,
      history,
      rounds,
      roundInfo,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateLabel = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `padel-ladder-backup-${dateLabel}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function triggerImport() {
    if (fileInputRef.current) fileInputRef.current.click();
  }

  async function handleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // zodat hetzelfde bestand opnieuw gekozen kan worden
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.players) || !Array.isArray(data.duos) || !Array.isArray(data.history)) {
        setError("Dit bestand lijkt geen geldige back-up van deze app te zijn.");
        return;
      }
      setError("");
      setPendingImport(data); // toont hieronder een bevestiging in de app zelf
    } catch {
      setError("Kon dit bestand niet lezen. Is het een JSON-back-up van deze app?");
    }
  }

  async function confirmImport() {
    if (!pendingImport) return;
    const data = pendingImport;
    setPendingImport(null);
    setError("");
    await persistPlayers(data.players);
    await persistDuos(data.duos);
    await persistHistory(data.history);
    // Ondersteunt zowel nieuwe back-ups (rounds: [...]) als oudere back-ups van
    // vóór deze functie (currentRound: {...}, precies 1 ronde).
    const importedRounds = Array.isArray(data.rounds)
      ? data.rounds
      : data.currentRound
      ? [data.currentRound]
      : [];
    await persistRounds(importedRounds);
    await persistRoundInfo(data.roundInfo || null);
  }

  // Wist alle data (spelers, duo's, geschiedenis, open rondes) — handig om schoon te
  // kunnen testen. Alleen beschikbaar voor de beheerder, met een bevestiging in de app zelf
  // (native browser-dialogen zoals window.confirm werken niet betrouwbaar in dit artifact).
  async function performReset() {
    setConfirmingReset(false);
    setError("");
    await persistPlayers([]);
    await persistDuos([]);
    await persistHistory([]);
    await persistRounds([]);
    await persistRoundInfo(null);
  }

  if (!loaded) {
    return (
      <div style={{ background: "#142D45", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{FONT_STYLE}</style>
        <div style={{ color: "#F2BE2C", fontFamily: "'Space Grotesk', sans-serif" }}>Laden…</div>
      </div>
    );
  }

  const sortedLadder = [...duos].sort((a, b) => a.position - b.position);
  const duosAlphabetical = [...duos].sort((a, b) =>
    duoName(a).localeCompare(duoName(b), "nl")
  );
  const assigned = assignedPlayerIds();
  const availableForA = players.filter((p) => !assigned.has(p.id) && p.id !== duoPlayerB);
  const availableForB = players.filter((p) => !assigned.has(p.id) && p.id !== duoPlayerA);

  return (
    <div style={styles.page}>
      <style>{FONT_STYLE}</style>

      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.eyebrow}>PADEL COMPETITIE · WEEK {getISOWeek(now)}</div>
          <h1 style={styles.title}>LADDER</h1>
          <p style={styles.subtitle}>
            {duos.length} {duos.length === 1 ? "duo" : "duo's"} · {players.length} {players.length === 1 ? "speler" : "spelers"} · Elke 2 weken een spannende wedstrijd
          </p>
        </div>
      </header>

      <nav style={styles.tabs}>
        <button
          onClick={() => setTab("ladder")}
          style={{ ...styles.tabBtn, ...(tab === "ladder" ? styles.tabBtnActive : {}) }}
        >
          <Trophy size={16} style={{ marginRight: 6 }} />
          Ranglijst
        </button>
        <button
          onClick={() => setTab("week")}
          style={{ ...styles.tabBtn, ...(tab === "week" ? styles.tabBtnActive : {}) }}
        >
          <Shuffle size={16} style={{ marginRight: 6 }} />
          Open
        </button>
        <button
          onClick={() => setTab("agenda")}
          style={{ ...styles.tabBtn, ...(tab === "agenda" ? styles.tabBtnActive : {}) }}
        >
          <Calendar size={16} style={{ marginRight: 6 }} />
          Agenda
        </button>
        <button
          onClick={() => setTab("spelers")}
          style={{ ...styles.tabBtn, ...(tab === "spelers" ? styles.tabBtnActive : {}) }}
        >
          <UserPlus size={16} style={{ marginRight: 6 }} />
          Spelers
        </button>
        <button
          onClick={() => setTab("manage")}
          style={{ ...styles.tabBtn, ...(tab === "manage" ? styles.tabBtnActive : {}) }}
        >
          <Users size={16} style={{ marginRight: 6 }} />
          Beheren
        </button>
      </nav>

      {error && (
        <div style={styles.errorBanner}>
          {error}
          <button onClick={() => setError("")} style={styles.errorClose}>
            <X size={14} />
          </button>
        </div>
      )}

      <main style={styles.main}>
        {tab === "ladder" && (
          <div>
            {sortedLadder.length === 0 ? (
              <EmptyState text="Nog geen duo's op de ladder. Ga naar 'Beheren' om spelers en duo's toe te voegen." />
            ) : (
              <div style={styles.ladder}>
                {sortedLadder.map((d) => {
                  const isExpanded = expandedDuoId === d.id;
                  const duoHistory = isExpanded ? getDuoHistory(d.id) : [];
                  return (
                    <div key={d.id}>
                      <button
                        onClick={() => setExpandedDuoId(isExpanded ? null : d.id)}
                        style={styles.rungBtn}
                      >
                        <div style={styles.posBadge}>{d.position}</div>
                        <div style={styles.rungBody}>
                          <div style={styles.duoName}>{duoName(d)}</div>
                        </div>
                        <div style={styles.record}>
                          {d.wins}W&nbsp;–&nbsp;{d.losses}V
                        </div>
                        <ChevronDown
                          size={16}
                          style={{
                            marginLeft: 8,
                            color: "rgba(246,244,236,0.4)",
                            transform: isExpanded ? "rotate(180deg)" : "none",
                            transition: "transform 0.15s",
                            flexShrink: 0,
                          }}
                        />
                      </button>
                      {isExpanded && (
                        <div style={styles.duoHistoryBox}>
                          {duoHistory.length === 0 ? (
                            <p style={styles.duoHistoryEmpty}>
                              Dit duo heeft nog geen wedstrijden gespeeld.
                            </p>
                          ) : (
                            duoHistory.map((h) => {
                              const opponent = duoById(h.opponentId);
                              return (
                                <div key={h.id} style={styles.duoHistoryRow}>
                                  <span style={styles.duoHistoryRound}>
                                    {h.round ? `Ronde ${h.round}` : `Week ${h.week}`}
                                  </span>
                                  <span
                                    style={{
                                      ...styles.duoHistoryResult,
                                      color: h.won ? "#F2BE2C" : "#E08A6E",
                                    }}
                                  >
                                    {h.won ? "Gewonnen van" : "Verloren van"}{" "}
                                    {opponent ? duoName(opponent) : "onbekend duo"}
                                  </span>
                                  {typeof h.ownScore === "number" && (
                                    <span style={styles.duoHistoryScore}>
                                      {h.ownScore}-{h.oppScore}
                                    </span>
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === "week" && (
          <div>
            {!latestRound ? (
              <div style={styles.generateBox}>
                <p style={styles.generateText}>
                  Genereer een voorstel voor Ronde {nextRoundNumber} (week {getISOWeek(now)}).
                  Duo's die de langste tijd niet speelden krijgen voorrang, en combinaties worden
                  zo gekozen dat er zo min mogelijk herhaling is. Eenmaal gegenereerd liggen de
                  wedstrijden vast: kies per wedstrijd een baan en een tijdstip, en wijs daarna via
                  de Agenda de winnaar aan. Zodra alle wedstrijden van een ronde zijn ingepland,
                  mag de beheerder alvast een volgende ronde genereren — ook als deze ronde nog
                  niet is afgerond.
                </p>
                {!isAdmin ? (
                  <p style={styles.roundHint}>
                    Alleen de beheerder kan een nieuwe ronde genereren.
                  </p>
                ) : (
                  <>
                    {roundLimitReached && (
                      <p style={styles.adminBypassNote}>
                        <Unlock size={12} style={{ marginRight: 6 }} />
                        Beheerder: 2-wekenlimiet omzeild ({daysUntilNextRound}{" "}
                        {daysUntilNextRound === 1 ? "dag" : "dagen"} eerder dan normaal)
                      </p>
                    )}
                    <button onClick={generateProposal} style={styles.primaryBtn}>
                      <Shuffle size={16} style={{ marginRight: 8 }} />
                      Genereer wedstrijden
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div>
                <p style={styles.roundBadgeText}>RONDE {latestRound.roundNumber}</p>
                <div style={styles.duoFilterRow}>
                  <select
                    value={duoFilter}
                    onChange={(e) => setDuoFilter(e.target.value)}
                    style={styles.select}
                  >
                    <option value="">Alle duo's</option>
                    {duosAlphabetical.map((d) => (
                      <option key={d.id} value={d.id}>
                        {duoName(d)}
                      </option>
                    ))}
                  </select>
                </div>
                {(() => {
                  const openMatches = latestRound.matches.filter(
                    (m) =>
                      m.status === "pending" &&
                      (!m.court || !m.scheduledAt) &&
                      (!duoFilter || m.duoAId === duoFilter || m.duoBId === duoFilter)
                  );
                  const filteredDuo = duoFilter ? duoById(duoFilter) : null;
                  return openMatches.length > 0 ? (
                    <>
                      <p style={styles.generateText}>
                        Kies per wedstrijd een baan en een datum + tijd. Zodra beide zijn ingevuld,
                        verschijnt de wedstrijd in de Agenda — daar wijs je later de winnaar aan.
                      </p>
                      <div style={styles.openMatchesList}>
                        {openMatches.map((m) => renderMatchCard(m, { showResultButtons: false }))}
                      </div>
                    </>
                  ) : (
                    <EmptyState
                      text={
                        filteredDuo
                          ? `Geen openstaande wedstrijden voor ${duoName(filteredDuo)}.`
                          : "Alle wedstrijden van deze ronde zijn ingepland — je vindt ze terug in de Agenda."
                      }
                    />
                  );
                })()}

                {latestRound.restDuoIds.length > 0 && (
                  <div style={styles.restBox}>
                    <div style={styles.restLabel}>Rust deze week</div>
                    <div style={styles.restList}>
                      {latestRound.restDuoIds.map((id) => {
                        const d = duoById(id);
                        if (!d) return null;
                        return (
                          <span key={id} style={styles.restChip}>
                            {duoName(d)}
                            {d.paused && <span style={styles.restChipTag}> · gepauzeerd</span>}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {!latestRoundFullyScheduled ? (
                  <p style={styles.roundHint}>
                    Zodra bij elke wedstrijd hierboven een baan én een datum/tijd zijn ingesteld,
                    mag de beheerder een nieuwe ronde genereren — ook als deze ronde nog niet is
                    afgerond.
                  </p>
                ) : !isAdmin ? (
                  <p style={styles.roundHint}>
                    Alleen de beheerder kan een nieuwe ronde genereren.
                  </p>
                ) : (
                  <div style={styles.weekActions}>
                    {roundLimitReached && (
                      <p style={styles.adminBypassNote}>
                        <Unlock size={12} style={{ marginRight: 6 }} />
                        Beheerder: 2-wekenlimiet omzeild
                      </p>
                    )}
                    <button onClick={generateProposal} style={styles.primaryBtn}>
                      <Shuffle size={16} style={{ marginRight: 8 }} />
                      Ronde {nextRoundNumber} genereren
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "agenda" && (
          <div>
            {allMatches.some((m) => m.court && m.scheduledAt) && (
              <div style={styles.duoFilterRow}>
                <select
                  value={duoFilter}
                  onChange={(e) => setDuoFilter(e.target.value)}
                  style={styles.select}
                >
                  <option value="">Alle duo's</option>
                  {duosAlphabetical.map((d) => (
                    <option key={d.id} value={d.id}>
                      {duoName(d)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {allMatches.every((m) => !(m.court && m.scheduledAt)) ? (
              <EmptyState text="Nog geen enkele wedstrijd heeft een baan én tijd. Plan ze in bij 'Open'." />
            ) : (
              (() => {
                const scheduled = allMatches
                  .filter(
                    (m) =>
                      m.court &&
                      m.scheduledAt &&
                      (!duoFilter || m.duoAId === duoFilter || m.duoBId === duoFilter)
                  )
                  .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

                if (scheduled.length === 0) {
                  const filteredDuo = duoById(duoFilter);
                  return (
                    <EmptyState
                      text={
                        filteredDuo
                          ? `Geen geplande wedstrijden voor ${duoName(filteredDuo)}.`
                          : "Geen geplande wedstrijden."
                      }
                    />
                  );
                }

                const byDay = new Map();
                for (const m of scheduled) {
                  const dayKey = new Date(m.scheduledAt).toDateString();
                  if (!byDay.has(dayKey)) byDay.set(dayKey, []);
                  byDay.get(dayKey).push(m);
                }
                const dayGroups = Array.from(byDay.entries());

                return (
                  <div>
                    {dayGroups.map(([dayKey, matches]) => (
                      <div key={dayKey} style={styles.agendaDay}>
                        <div style={styles.agendaDayHeading}>
                          {formatDateDMY(new Date(dayKey))}
                        </div>
                        <div style={styles.courtsGrid}>{matches.map(renderMatchCard)}</div>
                      </div>
                    ))}
                  </div>
                );
              })()
            )}
          </div>
        )}


        {tab === "spelers" && (
          <div>
            <section style={styles.manageSection}>
              <div style={styles.manageSectionHeading}>
                <UserPlus size={16} style={{ marginRight: 8 }} />
                Spelers
              </div>
              <p style={styles.manageHint}>
                Elke speler wordt vastgelegd met naam en privé e-mailadres. Eenzelfde naam +
                e-mailadres kan maar één keer voorkomen. E-mailadressen zijn standaard
                afgeschermd — alleen de beheerder kan ze volledig inzien.
              </p>
              <div style={styles.form}>
                <div style={styles.formRow}>
                  <input
                    value={newPlayerName}
                    onChange={(e) => setNewPlayerName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addPlayer()}
                    placeholder="Naam (bijv. Sander de Vries)"
                    style={styles.input}
                  />
                  <input
                    value={newPlayerEmail}
                    onChange={(e) => setNewPlayerEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addPlayer()}
                    placeholder="E-mailadres"
                    type="email"
                    style={styles.input}
                  />
                </div>
                <button onClick={addPlayer} style={styles.primaryBtn}>
                  <Plus size={16} style={{ marginRight: 8 }} />
                  Speler toevoegen
                </button>
              </div>

              <div style={styles.manageList}>
                {players.map((p) => {
                  const playerDuo = duos.find((d) => d.playerIds.includes(p.id));
                  const scheduleLocked = playerDuo && duoHasScheduledMatch(playerDuo.id);
                  const locked = !isAdmin || scheduleLocked;
                  const lockTitle = !isAdmin
                    ? "Alleen de beheerder kan spelers verwijderen."
                    : scheduleLocked
                    ? "Heeft wedstrijden staan in de Agenda — kan niet verwijderd worden"
                    : undefined;
                  return (
                    <div key={p.id} style={styles.manageRow}>
                      <div style={styles.manageInfo}>
                        <span>{p.name}</span>
                        <span style={styles.playerEmail}>
                          {isAdmin ? p.email : maskEmail(p.email)}
                        </span>
                      </div>
                      <button
                        onClick={() => removePlayer(p.id)}
                        disabled={locked}
                        title={lockTitle}
                        style={{
                          ...styles.deleteBtn,
                          ...(locked ? styles.deleteBtnDisabled : {}),
                        }}
                      >
                        {locked ? <Lock size={14} /> : <Trash2 size={14} />}
                      </button>
                    </div>
                  );
                })}
                {players.length === 0 && <EmptyState text="Nog geen spelers toegevoegd." />}
              </div>
            </section>

            <section style={styles.manageSection}>
              <div style={styles.manageSectionHeading}>
                <Link2 size={16} style={{ marginRight: 8 }} />
                Duo's samenstellen
              </div>
              <p style={styles.manageHint}>
                Koppel twee spelers aan elkaar tot een vast duo voor de ladder. Een speler kan
                maar in één duo tegelijk zitten. Zet een duo op pauze om ze tijdelijk uit te
                sluiten van nieuwe rondes — alle andere duo's spelen voortaan elke ronde.
              </p>
              <div style={styles.form}>
                <div style={styles.formRow}>
                  <select
                    value={duoPlayerA}
                    onChange={(e) => setDuoPlayerA(e.target.value)}
                    style={styles.select}
                  >
                    <option value="">Kies speler 1…</option>
                    {availableForA.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={duoPlayerB}
                    onChange={(e) => setDuoPlayerB(e.target.value)}
                    style={styles.select}
                  >
                    <option value="">Kies speler 2…</option>
                    {availableForB.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button onClick={addDuo} style={styles.primaryBtn}>
                  <Plus size={16} style={{ marginRight: 8 }} />
                  Duo vormen
                </button>
              </div>

              <div style={styles.manageList}>
                {sortedLadder.map((d) => {
                  const scheduleLocked = duoHasScheduledMatch(d.id);
                  const locked = !isAdmin || scheduleLocked;
                  const lockTitle = !isAdmin
                    ? "Alleen de beheerder kan duo's verwijderen."
                    : scheduleLocked
                    ? "Heeft wedstrijden staan in de Agenda — kan niet verwijderd worden"
                    : undefined;
                  return (
                    <div key={d.id} style={styles.manageRow}>
                      <div style={styles.manageInfo}>
                        <span style={styles.managePos}>#{d.position}</span>
                        <span>{duoName(d)}</span>
                        {d.paused && <span style={styles.pausedTag}>gepauzeerd</span>}
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          onClick={() => togglePauseDuo(d.id)}
                          title={
                            d.paused
                              ? "Pauze opheffen — dit duo doet weer mee vanaf de volgende ronde"
                              : "Op pauze zetten — dit duo wordt overgeslagen bij de volgende ronde"
                          }
                          style={{
                            ...styles.pauseBtn,
                            ...(d.paused ? styles.pauseBtnActive : {}),
                          }}
                        >
                          <Clock size={14} />
                        </button>
                        <button
                          onClick={() => removeDuo(d.id)}
                          disabled={locked}
                          title={lockTitle}
                          style={{
                            ...styles.deleteBtn,
                            ...(locked ? styles.deleteBtnDisabled : {}),
                          }}
                        >
                          {locked ? <Lock size={14} /> : <Trash2 size={14} />}
                        </button>
                      </div>
                    </div>
                  );
                })}
                {sortedLadder.length === 0 && <EmptyState text="Nog geen duo's samengesteld." />}
              </div>
            </section>
          </div>
        )}

        {tab === "manage" && (
          <div>
            <section style={styles.manageSection}>
              <div style={styles.manageSectionHeadingRow}>
                <div style={styles.manageSectionHeading}>
                  <Users size={16} style={{ marginRight: 8 }} />
                  Beheerder
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={addDemoData} style={styles.adminBtn}>
                    <Plus size={13} style={{ marginRight: 6 }} />
                    Demo data (8 duo's)
                  </button>
                  {isAdmin ? (
                    <button onClick={() => setIsAdmin(false)} style={styles.adminBtn}>
                      <Unlock size={13} style={{ marginRight: 6 }} />
                      E-mails zichtbaar · vergrendel
                    </button>
                  ) : (
                    <button onClick={() => setShowAdminForm((v) => !v)} style={styles.adminBtn}>
                      <Lock size={13} style={{ marginRight: 6 }} />
                      Beheerder
                    </button>
                  )}
                </div>
              </div>
              {showAdminForm && !isAdmin && (
                <div style={styles.adminForm}>
                  <input
                    value={adminInput}
                    onChange={(e) => setAdminInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && unlockAdmin()}
                    placeholder="Beheerderscode"
                    type="password"
                    style={styles.input}
                  />
                  <button onClick={unlockAdmin} style={styles.ghostBtn}>
                    Ontgrendel
                  </button>
                </div>
              )}
              <p style={styles.manageHint}>
                Ontgrendel als beheerder om e-mailadressen volledig te zien en om spelers/duo's
                te kunnen verwijderen. Demo data voegt snel wat testspelers en -duo's toe.
              </p>
            </section>

            <section style={styles.manageSection}>
              <div style={styles.manageSectionHeading}>
                <Download size={16} style={{ marginRight: 8 }} />
                Back-up
              </div>
              <p style={styles.manageHint}>
                Alle data (spelers, duo's, ladderstand en wedstrijdgeschiedenis) staat alleen in
                dit artifact. Exporteer regelmatig een back-up als je 'm ergens anders veilig wilt
                bewaren. Importeren vervangt alle huidige data door de inhoud van het bestand.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button onClick={exportData} style={styles.primaryBtn}>
                  <Download size={16} style={{ marginRight: 8 }} />
                  Exporteer back-up
                </button>
                <button onClick={triggerImport} style={styles.ghostBtn}>
                  <Upload size={14} style={{ marginRight: 8 }} />
                  Importeer back-up
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json"
                  onChange={handleImportFile}
                  style={{ display: "none" }}
                />
              </div>

              {pendingImport && (
                <div style={styles.confirmBox}>
                  <p style={styles.confirmBoxText}>
                    Dit vervangt alle huidige spelers, duo's en geschiedenis door de inhoud van
                    dit back-upbestand ({pendingImport.players?.length ?? 0} spelers,{" "}
                    {pendingImport.duos?.length ?? 0} duo's). Doorgaan?
                  </p>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button onClick={confirmImport} style={styles.primaryBtn}>
                      <Upload size={14} style={{ marginRight: 8 }} />
                      Ja, importeren
                    </button>
                    <button onClick={() => setPendingImport(null)} style={styles.ghostBtn}>
                      Annuleren
                    </button>
                  </div>
                </div>
              )}

              {isAdmin && (
                <div style={styles.dangerZone}>
                  <div style={styles.dangerZoneTitle}>Beheerder — gevarenzone</div>
                  <p style={styles.manageHint}>
                    Verwijdert alle spelers, duo's, de ladderstand en de volledige
                    wedstrijdgeschiedenis (incl. eventuele demo-data). Handig om schoon te kunnen
                    testen. Maak eerst een back-up als je iets wilt bewaren.
                  </p>
                  {!confirmingReset ? (
                    <button onClick={() => setConfirmingReset(true)} style={styles.dangerBtn}>
                      <Trash2 size={14} style={{ marginRight: 8 }} />
                      Alle data verwijderen
                    </button>
                  ) : (
                    <div style={styles.confirmBox}>
                      <p style={styles.confirmBoxText}>
                        Weet je het zeker? Dit kan niet ongedaan gemaakt worden.
                      </p>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <button onClick={performReset} style={styles.dangerBtn}>
                          <Trash2 size={14} style={{ marginRight: 8 }} />
                          Ja, verwijder alles
                        </button>
                        <button
                          onClick={() => setConfirmingReset(false)}
                          style={styles.ghostBtn}
                        >
                          Annuleren
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function EmptyState({ text }) {
  return <div style={styles.empty}>{text}</div>;
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#142D45",
    fontFamily: "'Space Grotesk', sans-serif",
    color: "#F6F4EC",
    position: "relative",
    paddingBottom: 60,
  },
  header: {
    padding: "48px 20px 24px",
    borderBottom: "1px solid rgba(246,244,236,0.12)",
    position: "relative",
  },
  headerInner: { maxWidth: 760, margin: "0 auto" },
  logo: {
    height: 56,
    width: "auto",
    marginBottom: 14,
    display: "block",
  },
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: "0.12em",
    color: "#F2BE2C",
    marginBottom: 8,
  },
  title: {
    fontFamily: "'Bebas Neue', sans-serif",
    fontSize: "clamp(56px, 12vw, 96px)",
    letterSpacing: "0.02em",
    margin: 0,
    lineHeight: 0.95,
    color: "#F6F4EC",
  },
  subtitle: {
    marginTop: 8,
    color: "rgba(246,244,236,0.65)",
    fontSize: 15,
  },
  tabs: {
    maxWidth: 760,
    margin: "0 auto",
    display: "flex",
    gap: 4,
    padding: "20px 20px 0",
    flexWrap: "wrap",
  },
  tabBtn: {
    display: "flex",
    alignItems: "center",
    background: "transparent",
    border: "1px solid rgba(246,244,236,0.18)",
    color: "rgba(246,244,236,0.7)",
    padding: "10px 16px",
    borderRadius: 999,
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  tabBtnActive: {
    background: "#F2BE2C",
    borderColor: "#F2BE2C",
    color: "#14283A",
  },
  errorBanner: {
    maxWidth: 760,
    margin: "16px auto 0",
    background: "rgba(193,87,58,0.18)",
    border: "1px solid #C1573A",
    color: "#F6F4EC",
    padding: "10px 14px",
    borderRadius: 8,
    fontSize: 14,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  errorClose: {
    background: "transparent",
    border: "none",
    color: "#F6F4EC",
    cursor: "pointer",
  },
  main: {
    maxWidth: 760,
    margin: "0 auto",
    padding: "28px 20px 0",
    position: "relative",
  },
  ladder: {
    display: "flex",
    flexDirection: "column",
    position: "relative",
  },
  rungBtn: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    width: "100%",
    background: "rgba(246,244,236,0.04)",
    border: "1px solid rgba(246,244,236,0.1)",
    borderRadius: 10,
    padding: "14px 16px",
    marginBottom: 0,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "'Space Grotesk', sans-serif",
    color: "#F6F4EC",
  },
  duoHistoryBox: {
    background: "rgba(246,244,236,0.03)",
    border: "1px solid rgba(246,244,236,0.08)",
    borderTop: "none",
    borderRadius: "0 0 10px 10px",
    padding: "10px 16px 14px 74px",
    marginBottom: 10,
  },
  duoHistoryEmpty: {
    fontSize: 13,
    color: "rgba(246,244,236,0.45)",
  },
  duoHistoryRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    fontSize: 13,
    padding: "6px 0",
    borderBottom: "1px solid rgba(246,244,236,0.06)",
  },
  duoHistoryRound: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11.5,
    color: "rgba(246,244,236,0.5)",
    minWidth: 64,
  },
  duoHistoryResult: {
    fontWeight: 600,
  },
  duoHistoryScore: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: "rgba(246,244,236,0.6)",
    marginLeft: "auto",
  },
  posBadge: {
    fontFamily: "'Bebas Neue', sans-serif",
    fontSize: 26,
    background: "#F2BE2C",
    color: "#14283A",
    width: 42,
    height: 42,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  rungBody: { flex: 1, minWidth: 0 },
  duoName: { fontWeight: 700, fontSize: 16 },
  record: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    color: "rgba(246,244,236,0.75)",
    whiteSpace: "nowrap",
  },
  generateBox: {
    background: "rgba(246,244,236,0.04)",
    border: "1px dashed rgba(246,244,236,0.25)",
    borderRadius: 12,
    padding: "28px 24px",
    textAlign: "center",
  },
  generateText: {
    color: "rgba(246,244,236,0.75)",
    fontSize: 15,
    marginBottom: 18,
    lineHeight: 1.5,
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#F2BE2C",
    color: "#14283A",
    border: "none",
    padding: "12px 20px",
    borderRadius: 8,
    fontFamily: "'Space Grotesk', sans-serif",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  },
  ghostBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    color: "#F6F4EC",
    border: "1px solid rgba(246,244,236,0.25)",
    padding: "12px 20px",
    borderRadius: 8,
    fontFamily: "'Space Grotesk', sans-serif",
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
  },
  courtsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 14,
  },
  openMatchesList: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  courtCard: {
    background: "#1C3E5A",
    border: "1px solid rgba(246,244,236,0.12)",
    borderRadius: 12,
    padding: 18,
  },
  courtLabel: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: "0.1em",
    color: "#F2BE2C",
    marginBottom: 12,
  },
  courtSelectRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  courtSelect: {
    flex: "1 1 auto",
    background: "#0F2C3F",
    border: "1px solid rgba(246,244,236,0.3)",
    borderRadius: 6,
    padding: "8px 10px",
    color: "#F2BE2C",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    fontWeight: 600,
    outline: "none",
    colorScheme: "dark",
  },
  fieldMissing: {
    borderColor: "#E08A6E",
    boxShadow: "0 0 0 1px rgba(224,138,110,0.4)",
  },
  courtConflict: {
    fontSize: 11,
    color: "#E08A6E",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  roundTag: {
    textAlign: "center",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    letterSpacing: "0.08em",
    color: "rgba(246,244,236,0.4)",
    marginBottom: 6,
  },
  matchup: { textAlign: "center", marginBottom: 10 },
  matchupDuo: { fontWeight: 700, fontSize: 17, lineHeight: 1.3 },
  vs: {
    fontFamily: "'Bebas Neue', sans-serif",
    fontSize: 20,
    color: "rgba(246,244,236,0.4)",
    margin: "4px 0",
  },
  freshTag: {
    fontSize: 12,
    textAlign: "center",
    padding: "5px 10px",
    borderRadius: 999,
    marginBottom: 14,
    fontFamily: "'JetBrains Mono', monospace",
  },
  freshTagGood: { background: "rgba(242,190,44,0.18)", color: "#F2BE2C" },
  freshTagNeutral: { background: "rgba(246,244,236,0.08)", color: "rgba(246,244,236,0.6)" },
  scheduleLabel: {
    display: "flex",
    alignItems: "center",
    fontSize: 12,
    color: "rgba(246,244,236,0.6)",
    marginBottom: 6,
  },
  scheduleRow: {
    display: "flex",
    gap: 8,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  scheduleDateInput: {
    flex: "1 1 60%",
    background: "#0F2C3F",
    border: "1px solid rgba(246,244,236,0.3)",
    borderRadius: 6,
    padding: "8px 10px",
    color: "#F6F4EC",
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 13,
    outline: "none",
    colorScheme: "dark",
  },
  scheduleTimeSelect: {
    flex: "1 1 40%",
    background: "#0F2C3F",
    border: "1px solid rgba(246,244,236,0.3)",
    borderRadius: 6,
    padding: "8px 6px",
    color: "#F6F4EC",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    outline: "none",
    colorScheme: "dark",
  },
  resultRow: { display: "flex", flexDirection: "column", gap: 6 },
  confirmScheduleBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(242,190,44,0.18)",
    border: "1px solid rgba(242,190,44,0.5)",
    color: "#F2BE2C",
    padding: "8px 10px",
    borderRadius: 6,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "'Space Grotesk', sans-serif",
    marginBottom: 4,
  },
  scheduleConfirmedTag: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "rgba(246,244,236,0.6)",
    fontSize: 11.5,
    fontFamily: "'JetBrains Mono', monospace",
    marginBottom: 10,
  },
  winBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(246,244,236,0.06)",
    border: "1px solid rgba(246,244,236,0.15)",
    color: "#F6F4EC",
    padding: "8px 10px",
    borderRadius: 6,
    fontSize: 12.5,
    cursor: "pointer",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  cancelBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "1px solid rgba(193,87,58,0.5)",
    color: "#E08A6E",
    padding: "8px 10px",
    borderRadius: 6,
    fontSize: 12.5,
    cursor: "pointer",
    fontFamily: "'Space Grotesk', sans-serif",
    marginTop: 4,
  },
  scoreEntryBox: {
    background: "rgba(242,190,44,0.08)",
    border: "1px solid rgba(242,190,44,0.3)",
    borderRadius: 8,
    padding: 12,
    marginBottom: 4,
  },
  scoreEntryTitle: {
    fontSize: 12.5,
    fontWeight: 600,
    color: "#F2BE2C",
    marginBottom: 10,
    textAlign: "center",
  },
  scoreRow: {
    display: "flex",
    gap: 8,
    marginBottom: 10,
    flexWrap: "wrap",
  },
  scoreField: {
    flex: "1 1 100px",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  scoreLabel: {
    fontSize: 11,
    color: "rgba(246,244,236,0.6)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  scoreInput: {
    width: "100%",
    minWidth: 0,
    background: "#0F2C3F",
    border: "1px solid rgba(246,244,236,0.3)",
    borderRadius: 6,
    padding: "8px 10px",
    color: "#F6F4EC",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 15,
    textAlign: "center",
    outline: "none",
    colorScheme: "dark",
  },
  doneTag: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(242,190,44,0.15)",
    color: "#F2BE2C",
    padding: "10px 10px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
  },
  doneTagDate: {
    marginTop: 4,
    fontSize: 11.5,
    fontWeight: 400,
    fontFamily: "'JetBrains Mono', monospace",
    color: "rgba(242,190,44,0.75)",
  },
  cancelledTag: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(246,244,236,0.06)",
    color: "rgba(246,244,236,0.5)",
    padding: "10px 10px",
    borderRadius: 6,
    fontSize: 13,
  },
  roundHint: {
    color: "rgba(246,244,236,0.55)",
    fontSize: 13.5,
    lineHeight: 1.5,
    marginTop: 20,
    textAlign: "center",
  },
  roundBadgeText: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: "0.1em",
    color: "#F2BE2C",
    marginBottom: 16,
  },
  duoFilterRow: {
    marginBottom: 16,
    display: "flex",
  },
  adminBypassNote: {
    display: "flex",
    alignItems: "center",
    fontSize: 12,
    color: "rgba(242,190,44,0.85)",
    marginBottom: 10,
    fontFamily: "'Space Grotesk', sans-serif",
  },
  restBox: { marginTop: 20 },
  restLabel: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: "rgba(246,244,236,0.5)",
    marginBottom: 8,
  },
  restList: { display: "flex", flexWrap: "wrap", gap: 8 },
  restChip: {
    background: "rgba(246,244,236,0.06)",
    border: "1px solid rgba(246,244,236,0.15)",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 13,
  },
  restChipTag: {
    color: "#F2BE2C",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
  },
  weekActions: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 22,
    flexWrap: "wrap",
    gap: 10,
  },
  historySection: {
    marginTop: 40,
    borderTop: "1px solid rgba(246,244,236,0.1)",
    paddingTop: 20,
  },
  historyHeading: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: "0.08em",
    color: "rgba(246,244,236,0.5)",
    marginBottom: 12,
  },
  historyRow: {
    display: "flex",
    gap: 12,
    fontSize: 13,
    padding: "8px 0",
    borderBottom: "1px solid rgba(246,244,236,0.06)",
    color: "rgba(246,244,236,0.7)",
  },
  historyWeek: { fontFamily: "'JetBrains Mono', monospace", flexShrink: 0, color: "#F2BE2C" },
  historyPairs: {},
  agendaDay: {
    marginBottom: 28,
  },
  agendaDayHeading: {
    fontFamily: "'Bebas Neue', sans-serif",
    fontSize: 20,
    letterSpacing: "0.03em",
    color: "#F2BE2C",
    marginBottom: 10,
    textTransform: "capitalize",
  },
  manageSection: {
    marginBottom: 36,
    paddingBottom: 8,
  },
  manageSectionHeadingRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 6,
  },
  manageSectionHeading: {
    display: "flex",
    alignItems: "center",
    fontFamily: "'Bebas Neue', sans-serif",
    fontSize: 22,
    letterSpacing: "0.03em",
    color: "#F2BE2C",
    marginBottom: 0,
  },
  adminBtn: {
    display: "flex",
    alignItems: "center",
    background: "rgba(246,244,236,0.06)",
    border: "1px solid rgba(246,244,236,0.18)",
    color: "rgba(246,244,236,0.75)",
    padding: "6px 12px",
    borderRadius: 999,
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 12.5,
    cursor: "pointer",
  },
  adminForm: {
    display: "flex",
    gap: 8,
    marginBottom: 14,
    flexWrap: "wrap",
  },
  dangerZone: {
    marginTop: 20,
    paddingTop: 16,
    borderTop: "1px dashed rgba(224,138,110,0.4)",
  },
  dangerZoneTitle: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: "0.1em",
    color: "#E08A6E",
    marginBottom: 8,
  },
  dangerBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "1px solid #C1573A",
    color: "#E08A6E",
    padding: "10px 16px",
    borderRadius: 8,
    fontFamily: "'Space Grotesk', sans-serif",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
  },
  confirmBox: {
    background: "rgba(224,138,110,0.08)",
    border: "1px solid rgba(224,138,110,0.35)",
    borderRadius: 8,
    padding: 14,
    marginTop: 12,
  },
  confirmBoxText: {
    fontSize: 13.5,
    color: "#F6F4EC",
    marginBottom: 12,
    lineHeight: 1.5,
  },
  manageHint: {
    color: "rgba(246,244,236,0.55)",
    fontSize: 13.5,
    marginBottom: 16,
    lineHeight: 1.5,
  },
  form: { marginBottom: 20 },
  formRow: { display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" },
  input: {
    flex: "1 1 220px",
    background: "rgba(246,244,236,0.06)",
    border: "1px solid rgba(246,244,236,0.2)",
    borderRadius: 8,
    padding: "11px 14px",
    color: "#F6F4EC",
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 14,
    outline: "none",
  },
  select: {
    flex: "1 1 220px",
    background: "#0F2C3F",
    border: "1px solid rgba(246,244,236,0.3)",
    borderRadius: 8,
    padding: "11px 14px",
    color: "#F6F4EC",
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 14,
    outline: "none",
    colorScheme: "dark",
  },
  manageList: { display: "flex", flexDirection: "column", gap: 8 },
  manageRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "rgba(246,244,236,0.04)",
    border: "1px solid rgba(246,244,236,0.1)",
    borderRadius: 8,
    padding: "10px 14px",
  },
  manageInfo: { display: "flex", gap: 10, alignItems: "center", fontSize: 14, flexWrap: "wrap" },
  managePos: { fontFamily: "'JetBrains Mono', monospace", color: "#F2BE2C" },
  pausedTag: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: "#F2BE2C",
    background: "rgba(242,190,44,0.15)",
    padding: "2px 8px",
    borderRadius: 999,
  },
  pauseBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "1px solid rgba(246,244,236,0.2)",
    color: "rgba(246,244,236,0.6)",
    cursor: "pointer",
    padding: 6,
    borderRadius: 6,
  },
  pauseBtnActive: {
    background: "rgba(242,190,44,0.18)",
    border: "1px solid rgba(242,190,44,0.5)",
    color: "#F2BE2C",
  },
  playerEmail: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: "rgba(246,244,236,0.5)",
  },
  deleteBtn: {
    background: "transparent",
    border: "none",
    color: "rgba(246,244,236,0.5)",
    cursor: "pointer",
    padding: 6,
  },
  deleteBtnDisabled: {
    color: "rgba(246,244,236,0.25)",
    cursor: "not-allowed",
  },
  empty: {
    textAlign: "center",
    color: "rgba(246,244,236,0.5)",
    padding: "40px 20px",
    fontSize: 14,
  },
};
