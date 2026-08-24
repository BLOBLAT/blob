-- Arena names appear in real-time chat, rankings, and results. Canonical
-- uniqueness prevents a second wallet from impersonating an existing profile.
-- If a pre-launch database contains duplicates, this migration intentionally
-- stops rather than selecting a name or silently changing a player's profile.
CREATE UNIQUE INDEX "User_displayNameKey_key" ON "User"("displayNameKey");
