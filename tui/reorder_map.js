// Pure helpers for the Account tab "Reorder Profiles" action.
// Reordering = swapping folder names so on-disk "Profile N" IDs follow the
// new visual order. IDs stay attached to list positions; names/data travel.

const PROFILE_RE = /^Profile \d+$/;

export function isNumberedProfile(dir) {
  return PROFILE_RE.test(dir || '');
}

// originalDirs and newDirs hold the same folder names; newDirs is the user's
// rearrangement. The folder currently named newDirs[i] must be renamed to
// originalDirs[i]. Returns { oldName: newName } for moved folders only.
export function buildReorderRenameMap(originalDirs, newDirs) {
  const map = {};
  newDirs.forEach((dir, i) => {
    if (dir !== originalDirs[i]) map[dir] = originalDirs[i];
  });
  return map;
}
