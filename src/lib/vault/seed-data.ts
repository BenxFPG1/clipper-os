/**
 * Seed-data voor de vault (sectie 8 van het bouwdocument).
 * Startgewichten staan op 0.5; de Retro-agent past ze aan op basis van eigen data.
 */

export const SEED_STRUCTURES = [
  {
    slug: 'belofte_afstraffing',
    name: 'Belofte & afstraffing',
    description:
      'Iemand doet vroeg een claim ("voor mij is dit makkelijk") die de video zelf later afstraft.',
    template: ['claim', 'bevestigingen', 'eerste barst', 'inzinking', 'reveal', 'button'],
  },
  {
    slug: 'opklimmende_leugen',
    name: 'Opklimmende leugen',
    description:
      'Momenten van één persoon herordend op geloofwaardigheid, oplopend tot de knal. Chronologie is ondergeschikt aan de curve.',
    template: ['meest geloofwaardig', 'twijfel', 'scheur', 'knal'],
  },
  {
    slug: 'herinterpretatie_na_reveal',
    name: 'Herinterpretatie na reveal',
    description:
      'Cold open met een oordeel zonder context, dan contextkaart, bewijsmomenten, en een reveal die alles herinterpreteert. Eindigt op een rewatch-trigger.',
    template: ['cold open oordeel', 'contextkaart', 'bewijsmomenten', 'reveal', 'rewatch-trigger'],
  },
  {
    slug: 'cold_open_flashback',
    name: 'Cold open flashback',
    description:
      'Start bij het vonnis of de payoff, dan de reconstructie hoe het daar kwam; het openingsshot herhaalt aan het einde mét context.',
    template: ['vonnis', 'reconstructie', 'escalatie', 'herhaling openingsshot met context'],
  },
  {
    slug: 'ironische_omkering',
    name: 'Ironische omkering',
    description: 'De groep stelt een regel of meetlat in die later henzelf of een onschuldige raakt.',
    template: ['regel wordt gesteld', 'toepassing op anderen', 'omkering', 'payoff'],
  },
  {
    slug: 'intro_reveal_format',
    name: 'Intro-reveal format',
    description:
      'Herbruikbaar sjabloon: alle intros achter elkaar, dan "wie is X?", 1 seconde stilte, dan de reveals in dezelfde volgorde. Werkt voor elke aflevering van hetzelfde format.',
    template: ['alle intros', 'vraag aan kijker', '1s stilte', 'reveals in dezelfde volgorde', 'comment-bait'],
  },
] as const;

export const SEED_HOOKS = [
  {
    slug: 'onthoud_deze_zin',
    formula: '"Onthoud deze zin." over een uitspraak die later stukgaat.',
    example: 'Onthoud deze zin: "voor mij is dit makkelijk"',
  },
  {
    slug: 'vonnis_zonder_context',
    formula: 'De conclusie als opener, gevolgd door "Hoe wist ze dat?"',
    example: 'Jij bent een man met snor. — Hoe wist ze dat?',
  },
  {
    slug: 'getal_absurditeit',
    formula: 'Een concreet absurd detail als opener.',
    example: 'Hij verzon een dode man, duistere handel en een Hema-BH.',
  },
  {
    slug: 'ze_hadden_het_mis',
    formula: 'Autoriteit die faalt, gebracht als belofte.',
    example: 'De expert wist het zeker. Kijk wat er gebeurt.',
  },
  {
    slug: 'vraag_aan_kijker',
    formula: 'Directe vraag die activatie in de comments uitlokt.',
    example: 'Kan jij de vrouw eruit halen?',
  },
  {
    slug: 'part_teaser',
    formula: 'Cliffhanger plus "antwoord in part 2", part 2 gepind in de comments.',
    example: 'Het antwoord staat in part 2.',
  },
] as const;

export const SEED_HEURISTICS = [
  'Geen aanloop: eerste frame is beweging plus audio mid-zin; elke seconde intro kost ongeveer 20% kijkers.',
  'Ondertitels altijd, groot, woord-voor-woord.',
  'Zoom op de reactie, niet op de spreker.',
  'Maximaal één sound effect per clip.',
  'Caption is een vraag, geen beschrijving.',
  'Tijdsprongen markeren met een consequent element (tekstkaart of minuut-teller).',
  'Eén persoon als anker per edit.',
  '3-5 posts per dag per account in week 1, daarna dubbelen op wat werkt.',
  'Variant = ander instappunt plus andere hook plus andere lengte; nooit een re-upload met andere tekst (ban-risico).',
] as const;

/** Voorbeeldcampagne ClipArmy x Supergaande (sectie 8). */
export const SEED_CAMPAIGN = {
  name: 'ClipArmy — Supergaande',
  cpm_eur: 0.5,
  budget_eur: null,
  status: 'active',
  platform_rules: {
    min_duration_seconds: 10,
    likes_comments_zichtbaar: true,
    taal: 'nl',
    min_dagen_live: 30,
    tags: {
      instagram: '@supergaande',
      tiktok: '@supergaande',
      youtube: '@SUPERGAANDETV',
    },
    beschrijvingsregel:
      'Bekijk de hele video nu op YouTube, Supergaande - Raad de Vrouw',
    hashtags: ['#supergaande'],
    alleen_bronvideo: true,
    geen_reposts: true,
    verboden_content: [
      'NSFW',
      'hate speech',
      'creator negatief neerzetten',
    ],
    uitbetaling_vanaf_views: 1000,
    max_eur_per_clip: 100,
  },
} as const;
