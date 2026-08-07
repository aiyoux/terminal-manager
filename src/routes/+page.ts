import { redirect } from '@sveltejs/kit';

/** Default landing: connections sidebar tab. */
export function load() {
	redirect(307, '/connections');
}
