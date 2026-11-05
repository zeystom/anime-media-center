/**
 * Shared types for the unified release-name parser.
 * Pure type module: contains no runtime code so it can be imported anywhere
 * (including from the zero-dependency regex engine) without pulling deps.
 */

export type ParsedRelease = {
  animeTitle: string | null;
  season: number | null;
  episodeNumber: number | null;
  episodeEnd?: number | null;
  episodeNumbers: number[];
  label: string;
  isMultiEpisode: boolean;
  isSpecial: boolean;
  specialType?: 'OVA' | 'OAD' | 'SP' | 'NCED' | 'NCOP' | 'Movie' | null;
  releaseGroup: string | null;
  resolution: string | null;
  videoTerm: string | null;
  audioTerm: string | null;
  subtitlesTerm: string | null;
  releaseType: 'TV' | 'Movie' | 'OVA' | 'OAD' | 'SP' | 'NCOP' | 'NCED' | 'Batch' | 'Unknown';
  parsedBy: 'regex' | 'anitomy';
  enrichedBy?: 'anitomy';
};
