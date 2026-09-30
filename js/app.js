/*
  World Quiz
  Data comes from data/countries.js (window.COUNTRIES) and data/world.js
  (window.WORLD). Libraries: d3 and topojson-client (see vendor/).
*/

/* Helpers */
const $ = (selector) => document.querySelector(selector);

// Makes typed answers comparable: lowercase, no accents, no punctuation,
// "&" -> "and", "St." -> "Saint", and a leading "the" is ignored.
function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/\bst\b/g, 'saint')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/^the /, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Id used to find a country's <path> on the map.
function featureDomId(feature) {
  return 'f' + (feature.id || feature.properties.name.replace(/\W/g, ''));
}

/* Constants */
const CONTINENTS = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania'];

// Geographic bounding box per continent: [west, south, east, north].
// Used to zoom the map in continent mode.
const CONTINENT_BOX = {
  'Africa': [-20, -36, 52, 38],
  'Asia': [25, -11, 150, 78],
  'Europe': [-25, 34, 65, 72],
  'North America': [-170, 7, -50, 74],
  'South America': [-82, -56, -34, 13],
  'Oceania': [110, -48, 180, 12],
};

const MAP_WIDTH = 960;
const MAP_HEIGHT = 500;

/* State */
let countries = []; // every country: name, flag code, continent, map shape...
let features = []; // map shapes from the topojson file

let mode; // 'country' (map question) or 'flag' (flag question)
let continent = null; // selected continent, or null for the whole world
let pickerType = 'country'; // what the continent picker will start: map or flags

let queue = []; // shuffled countries for the current round
let index = 0; // position in the queue
let score = 0;
let missed = []; // names of countries answered wrong
let answered = false; // true after the current question was checked

let mapGroup; // <g> that is zoomed and panned
let ring; // circle that marks the current country
let projection;
let zoomBehavior;

/* Loading and drawing the map */
function init() {
  try {
    features = topojson.feature(window.WORLD, window.WORLD.objects.countries).features;

    countries = window.COUNTRIES.map((c) => ({
      code: c.code,
      name: c.name,
      latlng: c.ll,
      continent: c.continent,
      // Match by numeric id first. Fall back to name.
      feature: (c.id && features.find((f) => f.id === c.id))
        || features.find((f) => f.properties.name === c.name),
      // All accepted spellings, already normalized.
      acceptedNames: c.names.map(normalize),
    }));

    drawMap();
    $('#status').textContent = countries.length + ' countries ready.';
  } catch (error) {
    $('#status').textContent = 'Could not load the game data: ' + error.message;
  }
}

function drawMap() {
  const svg = d3.select('#map');
  projection = d3.geoNaturalEarth1().fitSize([MAP_WIDTH, MAP_HEIGHT], { type: 'Sphere' });
  const path = d3.geoPath(projection);

  mapGroup = svg.append('g');

  mapGroup.append('g')
    .selectAll('path')
    .data(features)
    .join('path')
    .attr('d', path)
    .attr('id', featureDomId);

  ring = mapGroup.append('circle')
    .attr('id', 'ring')
    .attr('r', 9)
    .attr('stroke-width', 2);

  // Zoom and pan. Keep the ring the same size on screen while zooming.
  zoomBehavior = d3.zoom()
    .scaleExtent([1, 40])
    .translateExtent([[0, 0], [MAP_WIDTH, MAP_HEIGHT]])
    .on('zoom', (event) => {
      mapGroup.attr('transform', event.transform);
      ring
        .attr('r', 9 / event.transform.k)
        .attr('stroke-width', 2 / event.transform.k);
    });

  svg.call(zoomBehavior);
}

// Zoom transform that frames a whole continent.
function continentView(name) {
  const [west, south, east, north] = CONTINENT_BOX[name];
  const middle = (south + north) / 2;

  const corners = [
    [west, south], [west, north],
    [east, south], [east, north],
    [west, middle], [east, middle],
  ].map(projection);

  const x0 = d3.min(corners, (p) => p[0]);
  const x1 = d3.max(corners, (p) => p[0]);
  const y0 = d3.min(corners, (p) => p[1]);
  const y1 = d3.max(corners, (p) => p[1]);

  const scale = Math.min(MAP_WIDTH / (x1 - x0), MAP_HEIGHT / (y1 - y0)) * 0.92;

  return d3.zoomIdentity
    .translate(MAP_WIDTH / 2 - scale * (x0 + x1) / 2, MAP_HEIGHT / 2 - scale * (y0 + y1) / 2)
    .scale(scale);
}

/* Screens */
function showScreen(id) {
  ['home', 'pick', 'game', 'end'].forEach((screen) => {
    $('#' + screen).classList.toggle('hide', screen !== id);
  });
}

// Highlights one button in the top bar (or none).
function setActiveTab(modeName) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.mode === modeName);
  });
}

function openContinentPicker() {
  if (!countries.length) return;

  setActiveTab('continent');

  $('#conts').innerHTML = CONTINENTS.map((name) => {
    const count = countries.filter((c) => c.continent === name).length;
    return `
      <button class="mode cbtn" data-continent="${name}">
        <h2>${name}</h2>
        <span>${count} countries</span>
      </button>`;
  }).join('');

  showScreen('pick');
}

/* Game flow */
// Starts a new round. `continentName` is optional (omit for the whole world).
function startRound(newMode, continentName) {
  if (!countries.length) return;

  mode = newMode;
  continent = continentName || null;
  index = 0;
  score = 0;
  missed = [];

  // New random order on every round.
  queue = d3.shuffle(countries.filter((c) => !continent || c.continent === continent));

  setActiveTab(continent ? 'continent' : mode);
  showScreen('game');

  $('#map').classList.toggle('hide', mode !== 'country');
  $('#flagbox').classList.toggle('hide', mode !== 'flag');
  $('#question').textContent = mode === 'country'
    ? 'Which country is highlighted?'
    : 'Which country does this flag belong to?';

  askQuestion();
}

function askQuestion() {
  const current = queue[index];
  answered = false;

  $('#prog').textContent = `${continent || 'World'} · Question ${index + 1} of ${queue.length}`;
  $('#score').textContent = `Correct: ${score}`;
  $('#fb').textContent = '';
  $('#fb').className = '';
  $('#go').textContent = 'Check';
  $('#skip').classList.remove('hide');
  $('#ans').value = '';
  $('#ans').disabled = false;
  $('#ans').focus();

  if (mode === 'flag') {
    $('#flag').src = `flags/${current.code}.svg`;
  } else {
    showCountryOnMap(current);
  }
}

function showCountryOnMap(country) {
  // Highlight the country's shape.
  mapGroup.selectAll('path').classed('hl', false);
  if (country.feature) {
    d3.select('#' + featureDomId(country.feature)).classed('hl', true).raise();
  }

  // Put the ring on it (helps to find very small countries).
  const [x, y] = projection([country.latlng[1], country.latlng[0]]);
  ring.attr('cx', x).attr('cy', y);

  // Continent mode zooms to the continent, unless the country would be
  // outside that view (e.g. Samoa); then show the whole world.
  let view = d3.zoomIdentity;
  if (continent) {
    const candidate = continentView(continent);
    const screenX = candidate.x + candidate.k * x;
    const screenY = candidate.y + candidate.k * y;
    const inside = screenX > 10 && screenX < MAP_WIDTH - 10 && screenY > 10 && screenY < MAP_HEIGHT - 10;
    if (inside) view = candidate;
  }
  d3.select('#map').call(zoomBehavior.transform, view);
}

function finishQuestion(correct) {
  const current = queue[index];
  answered = true;

  if (correct) {
    score++;
  } else {
    missed.push(current.name);
  }

  $('#fb').className = correct ? 'ok' : 'bad';
  $('#fb').textContent = correct ? `Correct! ${current.name}` : `It's ${current.name}.`;
  $('#score').textContent = `Correct: ${score}`;
  $('#ans').disabled = true;
  $('#skip').classList.add('hide');
  $('#go').textContent = index + 1 < queue.length ? 'Next' : 'See results';
  $('#go').focus();
}

// "Check" button / Enter key: check the answer, or go on if already checked.
function submitAnswer() {
  if (answered) return nextQuestion();

  const guess = normalize($('#ans').value);
  if (!guess) return;

  finishQuestion(queue[index].acceptedNames.includes(guess));
}

function nextQuestion() {
  index++;
  if (index < queue.length) return askQuestion();
  showResults();
}

function showResults() {
  const kind = mode === 'country' ? 'map' : 'flag';

  $('#final').textContent = `${score} / ${queue.length} correct`;
  $('#finalsub').textContent = `${continent || 'World'} · ${kind} round finished.`;
  $('#chg').classList.toggle('hide', !continent);
  $('#mh').textContent = missed.length ? 'Missed' : 'Perfect round. Nothing missed!';
  $('#missed').innerHTML = missed.map((name) => `<li>${name}</li>`).join('');

  showScreen('end');
}

/* Event listeners */
// Mode cards on the home screen and mode buttons in the top bar.
document.querySelectorAll('[data-mode]').forEach((button) => {
  button.onclick = () => {
    if (button.dataset.mode === 'continent') {
      openContinentPicker();
    } else {
      startRound(button.dataset.mode);
    }
  };
});

$('#home-btn').onclick = () => {
  showScreen('home');
  setActiveTab(null);
};

// Continent picker: Map / Flags switch and the continent buttons.
$('#seg').onclick = (event) => {
  const button = event.target.closest('[data-type]');
  if (!button) return;

  pickerType = button.dataset.type;
  document.querySelectorAll('#seg button').forEach((b) => {
    b.classList.toggle('on', b === button);
  });
};

$('#conts').onclick = (event) => {
  const button = event.target.closest('[data-continent]');
  if (button) startRound(pickerType, button.dataset.continent);
};

// Answering
$('#go').onclick = submitAnswer;
$('#skip').onclick = () => finishQuestion(false);

$('#ans').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitAnswer();
});

// Enter also moves on once the answer is shown (the input is disabled then).
document.addEventListener('keydown', (event) => {
  const playing = !$('#game').classList.contains('hide');
  if (event.key === 'Enter' && answered && playing) nextQuestion();
});

// Results screen
$('#again').onclick = () => startRound(mode, continent);
$('#other').onclick = () => startRound(mode === 'country' ? 'flag' : 'country', continent);
$('#chg').onclick = openContinentPicker;

init();
