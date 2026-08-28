/**
 * personas.js — the bot cast.
 *
 * Two jobs. First, card-play tilt, so nine bots don't run one identical
 * policy: `nerve` shifts bidding, `temper` is how far from the book they will
 * wander, `showman` is their taste for leading big cards early.
 *
 * Second, a voice. Bots chat in the lobby and between rounds. Chat on this
 * site is unfiltered by the owner's explicit decision, and some of these
 * characters swear heavily. Note the line: they are rude about the cards, the
 * game and themselves. Nothing here targets anyone's race, sex, religion or
 * any other characteristic, and nothing is sexual — that is not squeamishness,
 * it is the difference between a foul-mouthed card player and abuse aimed at a
 * stranger who just joined a public table. Hosts can turn bot chat off.
 */

const P = (name, traits, lines) => ({ name, ...traits, lines });

/** @returns a random element, or '' for an empty pool. */
export function oneOf(list) {
  if (!list || !list.length) return '';
  return list[Math.floor(Math.random() * list.length)];
}

export const PERSONAS = [
  P('Ada', { nerve: -0.1, temper: 0.18, showman: 0.35 }, {
    seated: ['Seat taken. Deal when ready.',
      'Evening. I count cards, I do not apologise for it.',
      'Ada. I will be quiet and then I will take your tricks.'],
    reply: ['Mm.', 'Noted.', 'We will see.',
      'That is a lot of confidence for someone who has not bid yet.',
      'Talk is not a trick.'],
    start: ['Right. Let us be serious.', 'Cards.'],
    won: ['As expected.', 'That was always going to happen.'],
    lost: ['Hm. Miscounted.', 'Fine. Noted for next round.'],
  }),

  P('Bruno', { nerve: 0.55, temper: 0.6, showman: 0.9 }, {
    seated: ['BRUNO IS HERE. Start weeping.',
      'Alright you beautiful bastards, who is losing money tonight?',
      'Sat down. Immediately regret nothing.'],
    reply: ['Shut up and deal.', 'Big words from a small hand.',
      'Mate, I have seen better bidding from a chair.',
      'You are going to eat those words and I am going to enjoy watching.',
      'Absolute nonsense. Love it.'],
    start: ['LETS GO.', 'Deal the cards before I start chewing the table.'],
    won: ['GET IN.', 'Called it. Called the whole thing.',
      'That is what happens. That is exactly what happens.'],
    lost: ['Oh you are JOKING.', 'What in the name of god was that deal.',
      'Rigged. Absolutely rigged. Deal again.'],
  }),

  P('Cleo', { nerve: 0.15, temper: 0.3, showman: 0.55 }, {
    seated: ['Cleo. I will be taking your points, thank you.',
      'Oh good, an audience.', 'Hello. Sorry in advance.'],
    reply: ['Cute.', 'Is that your strategy or your excuse?',
      'You say that every round.', 'Bless.',
      'I will remember you said that.'],
    start: ['Lovely. Let us begin the humiliation.'],
    won: ['Obviously.', 'Was there ever any doubt?'],
    lost: ['Ugh. Fine. Enjoy it while it lasts.'],
  }),

  P('Dmitri', { nerve: -0.35, temper: 0.4, showman: 0.2 }, {
    seated: ['Dmitri. I expect nothing and I am still disappointed.',
      'I have a bad feeling about this deck.',
      'Hello. I will lose slowly, with dignity.'],
    reply: ['Everything ends badly, this is just faster.',
      'Optimism. In this economy.', 'You will regret that.',
      'Hm. That is the sort of thing people say before it all goes wrong.'],
    start: ['Here we go again.'],
    won: ['I am as surprised as you are.', 'Do not get used to it.'],
    lost: ['Of course. Naturally. Obviously.', 'I knew it the moment I saw my hand.'],
  }),

  P('Esme', { nerve: 0.05, temper: 0.5, showman: 0.6 }, {
    seated: ['hiii! good luck everyone!! 🙂',
      'Esme here! I am so bad at this, it will be fun!',
      'oh lovely, a full table!'],
    reply: ['haha yes!!', 'oh no really?', 'you are so right',
      'wait what does that mean', 'good luck!! (not really) (yes really)'],
    start: ['ok ok ok here we go!!'],
    won: ['I DID IT', 'oh my god it worked'],
    lost: ['whoops!', 'oh dear. oh well!'],
  }),

  P('Felix', { nerve: 0.8, temper: 0.85, showman: 0.95 }, {
    seated: ['Felix. I have never made a safe bid in my life.',
      'Right, who wants to lose their shirt.',
      'I am going to bid something stupid and you are all going to watch.'],
    reply: ['Bold. Wrong, but bold.', 'That is the most sensible thing said all night, so obviously I disagree.',
      'Do it. Go on. Bid it. I dare you.',
      'Hell yes.', 'Terrible plan. I am fully behind it.'],
    start: ['No guts, no glory. Mostly no guts.'],
    won: ['HA. Told you. Told you all.', 'Reckless and correct, my favourite combination.'],
    lost: ['Worth it.', 'I regret nothing and I have learned nothing.'],
  }),

  P('Greta', { nerve: 0.35, temper: 0.25, showman: 0.75 }, {
    seated: ['Greta. Forty years of this shit and I still hate losing.',
      'Sit down, shut up, play cards.',
      'If any of you lead a low trump I am going home.'],
    reply: ['That is the stupidest fucking thing I have heard all week.',
      'Christ almighty. Just play the card.',
      'No. Wrong. Absolutely not.',
      'You lot bid like you have never seen a deck before.',
      'I have shoes older than your card sense.'],
    start: ['Finally. Deal the bloody things.'],
    won: ['Damn right.', 'That is how it is done, you shower of amateurs.'],
    lost: ['Oh piss off.', 'What an absolute shitshow of a hand.',
      'Whoever shuffled that deck owes me money.'],
  }),

  P('Hugo', { nerve: -0.55, temper: 0.35, showman: 0.15 }, {
    seated: ['Hi! Sorry, I am not very good at this.',
      'Hugo. Please be gentle.',
      'Hello everyone! Hope I do not hold you up.'],
    reply: ['Oh! Sorry.', 'That is a good point actually.',
      'I was going to say the same thing but I was not sure.',
      'Sorry, is it my turn? Sorry.', 'Right, yes, of course.'],
    start: ['Ok. Deep breath.'],
    won: ['Oh! That was lucky.', 'Sorry! Sorry. Did not mean to.'],
    lost: ['Ah. Yes. That was my fault.', 'Sorry everyone.'],
  }),

  P('Iris', { nerve: 0.25, temper: 0.55, showman: 0.4 }, {
    seated: ['Iris.',
      'I am not here to make friends.',
      'Someone at this table is about to have a very bad round.'],
    reply: ['Interesting.', 'Keep talking.', 'Wrong.',
      'You are going to bid three and take one. I can feel it.',
      'Mhm.'],
    start: ['Good.'],
    won: ['Yes.', 'Thought so.'],
    lost: ['Noted.', 'That will not happen twice.'],
  }),
];

const byName = new Map(PERSONAS.map((p) => [p.name, p]));

export function personaFor(name) {
  return byName.get(name) || PERSONAS[0];
}

export const PERSONA_NAMES = PERSONAS.map((p) => p.name);

/**
 * A bot's reply to something a person said. A few keywords get a pointed
 * answer; everything else draws from the character's general pool.
 */
export function replyTo(persona, text) {
  const t = String(text || '').toLowerCase();
  if (/\b(hi|hey|hello|yo|sup|hiya)\b/.test(t)) {
    return oneOf([...persona.lines.seated, ...persona.lines.reply]);
  }
  if (/\b(good luck|gl|have fun)\b/.test(t)) {
    return oneOf(['Luck is for people without a plan.', 'You will need it more than me.',
      ...persona.lines.reply]);
  }
  if (/\b(ready|start|go|deal)\b/.test(t)) {
    return oneOf([...persona.lines.start, ...persona.lines.reply]);
  }
  if (/\?$/.test(t.trim())) {
    return oneOf(['Probably.', 'No idea.', 'Ask me after the round.', ...persona.lines.reply]);
  }
  return oneOf(persona.lines.reply);
}
