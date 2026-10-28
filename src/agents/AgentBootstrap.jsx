import { useEffect } from 'react';

import { registerHostAgents } from './bridge-agent-provider.js';
import { useStore } from '../store/workspace-store.js';

/*
 * Find out what the host can think with, once, at startup.
 *
 * Registration is separate from placement on purpose. Registering an adapter
 * says "this is available"; placing a node says "this is in my workspace". A
 * user who deletes the Claude node has said something, and rediscovery must
 * not undo it — so nodes are seeded only when the workspace has none at all,
 * which is the genuine first run.
 */
export const AgentBootstrap = () => {
  useEffect(() => {
    let cancelled = false;

    registerHostAgents().then((providers) => {
      if (cancelled || providers.length === 0) return;

      const store = useStore.getState();
      if (store.agents.length > 0) return; // The user already has a workspace.

      /* Placed to the left, at eye height, where the brief pictures them:
       * "Claude can float to the user's left." Spread along the same arc the
       * workspace already uses so nothing lands inside a window. */
      providers.forEach((provider, index) => {
        store.addAgent({
          name: provider.name,
          providerId: provider.id,
          position: [-2.6, 1.55 - index * 0.55, -1.4]
        });
      });
    });

    return () => { cancelled = true; };
  }, []);

  return null;
};

export default AgentBootstrap;
