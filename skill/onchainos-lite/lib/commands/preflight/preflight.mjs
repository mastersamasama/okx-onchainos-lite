// `onchainos preflight` — retired upstream; always fails with the upstream message.
export default {
  preflight: {
    uses: [],
    async run() {
      throw new Error('`onchainos preflight` is deprecated; use `npx -y @okxweb3/onchainos-installer install`');
    },
  },
};
