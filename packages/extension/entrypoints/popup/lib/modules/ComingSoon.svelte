<script lang="ts">
  import { Construction } from 'lucide-svelte';

  interface Props {
    label: string;
  }
  let { label }: Props = $props();
</script>

<div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
  <Construction class="size-10 text-slate-400" />
  <h2 class="text-base font-semibold text-slate-200">{label}</h2>
  <p class="max-w-xs text-xs text-slate-500">
    This module is being ported from the legacy extension. Check back in a future release.
  </p>
</div>
