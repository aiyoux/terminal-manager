<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { getTerminalGroups } from '$lib/stores.svelte';

  // Bare /groups: prefer first group tab, else connections. Layout also redirects.
  onMount(() => {
    const first = getTerminalGroups()[0];
    void goto(first ? `/groups/${first.id}` : '/connections', { replaceState: true });
  });
</script>
