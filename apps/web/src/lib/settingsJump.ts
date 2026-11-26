/** A Settings section's element id, from its title. */
export const groupId = (title: string) => `settings-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;

/** Scrolls Settings to a section (the section list, and links from elsewhere such as the status line). */
export function jumpTo(title: string) {
  const g = document.getElementById(groupId(title));
  const scroller = g?.closest<HTMLElement>('.overflow-y-auto');
  // scrollTop, not scrollIntoView: that can scroll the clipped page root too (CLAUDE.md).
  if (g && scroller) scroller.scrollTop += g.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
}
