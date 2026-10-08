# Rundor

Responsiv webbapp (mobil + desktop) som visar löp- och promenadrundor nära dig,
inspirerad av Stravas ruttvy. Helt baserad på öppna datakällor – ingen API-nyckel, inget byggsteg.

## Kör lokalt

Geolocation kräver `https` eller `localhost`, så servera mappen via en lokal webbserver:

```bash
python -m http.server 8765 --bind 127.0.0.1
```

Öppna sedan <http://127.0.0.1:8765/>.

## Funktioner

- Startar på användarens position (fallback: Stockholm)
- Platssök med förslag medan man skriver, plus "Sök i det här området" när kartan flyttas
- Distansfilter (dubbelreglage + snabbval, t.ex. 5–7 km)
- Filter för underlag (asfalt / grus / stig-terräng) och belysning
- Egen runda: genererar en slinga på vald distans från din position (eller kartans mitt), med "Ny variant"
- Installerbar app (PWA): "Installera"-knapp i Chrome/Android, "Lägg till på hemskärmen" i Safari på iOS
- Sortering: mest populära, närmast, längd
- Ruttdetaljer: distans, höjdmeter, höjdprofil, vägbeskrivning till start, GPX-export

## Datakällor

| Data | Källa | Licens |
|---|---|---|
| Rutter (route-relationer, motionsspår, elljusspår, namngivna stigar) | OpenStreetMap via Overpass API | ODbL |
| Platssök | Photon (komoot) | OSM-data, ODbL |
| Egna rundor (gångrouting) | FOSSGIS OSRM, `routing.openstreetmap.de/routed-foot` | OSM-data, ODbL; fair use |
| Höjddata | Open-Meteo Elevation API | CC BY 4.0 |
| Officiella leder i skyddade områden | Naturvårdsverket, WFS `leder_friluftsliv` (GeoJSON) | Öppna data, se Naturvårdsverkets villkor |
| parkrun-banor (startpunkter) | `images.parkrun.com/events.json` | parkruns villkor – kontrollera före kommersiell användning |
| Värmekarta + användning | Publika GPS-spår i OpenStreetMap (`gps.tile.openstreetmap.org`, `/api/0.6/trackpoints`) | Uppladdarnas spår, publika via OSM |
| Bakgrundskarta | OpenStreetMap standard tiles (byt till egen/kommersiell tile-leverantör vid större trafik) | ODbL |

**Popularitet:** Strava-heatmaps är inte öppen data. "Populär" vägs ihop av:

- **GPS-spår** – för de 15 högst rankade rundorna hämtas publika OSM-spårpunkter inom rundans bbox
  (max 2 sidor à 5 000 punkter). Ett spårsegment räknas om minst 20 punkter ligger inom 25 m från rundan.
  Privata spår (utan tidsstämplar, osorterade) ignoreras. Resultatet cachas 7 dagar i `localStorage`.
  Visas som "28+ GPS-spår" när sidtaket nåtts, alltså ett minimivärde.
- **Officiell led (+1,2)** – leder från Naturvårdsverket. Följer en OSM-runda minst 60 % av leden
  (inom 40 m) märks OSM-rundan; annars läggs leden till som en egen runda. Vinterleder (skid, skoter) och rid-/kanotleder tas bort.
- **parkrun-bana (+1,5)** – en runda på ca 4,5–5,7 km (eller med "parkrun" i namnet) som passerar
  inom 300 m från ett 5 km-parkruns startpunkt. Bara startpunkter är publika, så matchningen är en trolig bana.
- **OSM-taggar** – rutttyp, namn, belysning, skyltning/nätverk, slinga, samt avstånd.

Spåren laddas mest upp av OSM-kartläggare och blandar färdsätt, så siffran är en relativ indikator, inte ett exakt antal löpare.

## Underlag och belysning

Overpass-frågan hämtar även taggarna för varje rutts vägar. Underlaget är det som täcker störst andel
av längden (minst 40 %), annars okänt. Saknas `surface` gissas det från vägtyp: `track` = grus,
`path` = stig, övriga vägar = asfalt. Belyst = `lit=yes` på rutten, "elljus" i namnet eller minst 60 % belyst längd.
Rundor med okänt underlag visas inte när ett underlagsfilter är valt.

## Egna rundor

Tre punkter läggs på en cirkel som går genom startpunkten, och gångrutten start → punkterna → start
hämtas från FOSSGIS OSRM. Cirkeln skalas om tills rundan är inom 3 % av vald distans (max 5 försök).
Distansen är mitten av valt intervall. "Ny variant" slumpar en ny riktning.

## Installerbar app

`manifest.webmanifest`, ikoner i `icons/` och en service worker (`sw.js`). Service workern hämtar
appens egna filer från nätet först (så uppdateringar syns direkt) och sparar dem som reserv offline;
Leaflet cachas. Kartbilder och data-API:er cachas inte. Ikonerna genereras med `python tools/make_icons.py icons`.

## Begränsningar

- De publika Overpass-servrarna är delade och rate-limitar. Vid produktion: kör egen Overpass-instans
  eller förbearbeta data (t.ex. nattlig export till statiska GeoJSON-tiles).
- Rundor finns bara där de är kartlagda i OSM.
