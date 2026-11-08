# Age rating data

`age-ratings.json` is generated from the `r` (MyAnimeList age rating) field in
the anime-mapper search index:

- Source: https://github.com/subhajeetch-fl/anime-mapper
- Index: https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/search-index.json
- License: MIT (repository and dataset, as stated by the source project)
- The app refreshes its per-user cache at launch when it is at least 3 days old,
  and retries failed requests every 6 hours while the app remains open.
- Refresh the bundled fallback with `npm run update:age-ratings`

The generated file is a local MAL ID to age rating map, so the app does not
make per-title network requests when showing badges or filtering Discovery.
The downloaded refresh is saved separately in the app's user data directory.
