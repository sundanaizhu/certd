/**
 * ACME auto helper
 */
import { readCsrDomains } from './crypto/index.js';
import { log } from './logger.js';
import { wait } from './wait.js';
import { CancelError } from './error.js';


const defaultOpts = {
    csr: null,
    email: null,
    preferredChain: null,
    termsOfServiceAgreed: false,
    skipChallengeVerification: false,
    challengePriority: ['http-01', 'dns-01'],
    challengeCreateFn: async () => {
        throw new Error('Missing challengeCreateFn()');
    },
    challengeRemoveFn: async () => {
        throw new Error('Missing challengeRemoveFn()');
    },
};

/**
 * ACME client auto mode
 *
 * @param {AcmeClient} client ACME client
 * @param {object} userOpts Options
 * @returns {Promise<buffer>} Certificate
 */

export default  async (client, userOpts) => {
    const opts = { ...defaultOpts, ...userOpts };
    const accountPayload = { termsOfServiceAgreed: opts.termsOfServiceAgreed };

    if (!Buffer.isBuffer(opts.csr)) {
        opts.csr = Buffer.from(opts.csr);
    }

    if (opts.email) {
        accountPayload.contact = [`mailto:${opts.email}`];
    }
    if (opts.externalAccountBinding) {
        accountPayload.externalAccountBinding = opts.externalAccountBinding;
    }

    /**
     * Register account
     */

    log('[auto] Checking account');

    try {
        client.getAccountUrl();
        log('[auto] Account URL already exists, skipping account registration');
    }
    catch (e) {
        log('[auto] Registering account');
        await client.createAccount(accountPayload);
    }

    /**
     * Parse domains from CSR
     */

    log('[auto] Parsing domains from Certificate Signing Request');
    const { commonName, altNames } = readCsrDomains(opts.csr);
    const uniqueDomains = Array.from(new Set([commonName].concat(altNames).filter((d) => d)));

    log(`[auto] Resolved ${uniqueDomains.length} unique domains from parsing the Certificate Signing Request`);

    /**
     * Place order
     */

    log('[auto] Placing new certificate order with ACME provider');
    const orderPayload = { identifiers: uniqueDomains.map((d) => ({ type: 'dns', value: d })) };
    const order = await client.createOrder(orderPayload);
    const authorizations = await client.getAuthorizations(order);

    log(`[auto] Placed certificate order successfully, received ${authorizations.length} identity authorizations`);

    /**
     * Resolve and satisfy challenges
     */

    log('[auto] Resolving and satisfying authorization challenges');

    const clearTasks = [];

    const challengeFunc = async (authz) => {
        const d = authz.identifier.value;
        let challengeCompleted = false;

        /* Skip authz that already has valid status */
        if (authz.status === 'valid') {
            log(`[auto] [${d}] Authorization already has valid status, no need to complete challenges`);
            return;
        }

        const keyAuthorizationGetter = async (challenge) => {
            return await client.getChallengeKeyAuthorization(challenge);
        }

        try {
            log(`[auto] [${d}] Trigger challengeCreateFn()`);
            try {
                const { recordReq, recordRes, dnsProvider,challenge ,keyAuthorization} = await opts.challengeCreateFn(authz, keyAuthorizationGetter);
                clearTasks.push(async () => {
                    /* Trigger challengeRemoveFn(), suppress errors */
                    log(`[auto] [${d}] Trigger challengeRemoveFn()`);
                    try {
                        await opts.challengeRemoveFn(authz, challenge, keyAuthorization, recordReq, recordRes, dnsProvider);
                    }
                    catch (e) {
                        log(`[auto] [${d}] challengeRemoveFn threw error: ${e.message}`);
                    }
                });
                // throw new Error('测试异常');
                /* Challenge verification */
                if (opts.skipChallengeVerification === true) {
                    log(`[auto] [${d}] Skipping challenge verification since skipChallengeVerification=true，wait 60s`);
                    await wait(60 * 1000);
                }
                else {
                    log(`[auto] [${d}] Running challenge verification, type = ${challenge.type}`);
                    try {
                        await client.verifyChallenge(authz, challenge);
                    }
                    catch (e) {
                        log(`[auto] [${d}] challenge verification threw error: ${e.message}`);
                    }
                }
                /* Complete challenge and wait for valid status */
                log(`[auto] [${d}] Completing challenge with ACME provider and waiting for valid status`);
                await client.completeChallenge(challenge);
                challengeCompleted = true;

                await client.waitForValidStatus(challenge);
            }
            catch (e) {
                log(`[auto] [${d}] challengeCreateFn threw error: ${e.message}`);
                throw e;
            }
        }
        catch (e) {
            /* Deactivate pending authz when unable to complete challenge */
            if (!challengeCompleted) {
                log(`[auto] [${d}] Unable to complete challenge: ${e.message}`);

                try {
                    log(`[auto] [${d}] Deactivating failed authorization`);
                    await client.deactivateAuthorization(authz);
                }
                catch (f) {
                    /* Suppress deactivateAuthorization() errors */
                    log(`[auto] [${d}] Authorization deactivation threw error: ${f.message}`);
                }
            }

            throw e;
        }
    };
    const domainSets = [];

    authorizations.forEach((authz) => {
        const d = authz.identifier.value;
        log(`authorization:domain = ${d}, value = ${JSON.stringify(authz)}`);

        if (authz.status === 'valid') {
            log(`[auto] [${d}] Authorization already has valid status, no need to complete challenges`);
            return;
        }
        let setd = false;
        // eslint-disable-next-line no-restricted-syntax
        for (const group of domainSets) {
            if (!group[d]) {
                group[d] = authz;
                setd = true;
                break;
            }
        }
        if (!setd) {
            const group = {};
            group[d] = authz;
            domainSets.push(group);
        }
    });

    // log(`domainSets:${JSON.stringify(domainSets)}`);

    const allChallengePromises = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const domainSet of domainSets) {
        const challengePromises = [];
        // eslint-disable-next-line guard-for-in,no-restricted-syntax
        for (const domain in domainSet) {
            const authz = domainSet[domain];
            challengePromises.push(async () => {
                log(`[auto] [${domain}] Starting challenge`);
                await challengeFunc(authz);
            });
        }
        allChallengePromises.push(challengePromises);
    }

    log(`[auto] challengeGroups:${allChallengePromises.length}`);

    function runAllPromise(tasks) {
        let promise = Promise.resolve();
        tasks.forEach((task) => {
            promise = promise.then(task);
        });
        return promise;
    }

    async function runPromisePa(tasks) {
        const results = [];
        // eslint-disable-next-line no-await-in-loop,no-restricted-syntax
        for (const task of tasks) {
            results.push(task());
            // eslint-disable-next-line no-await-in-loop
            await wait(10000);
        }
        return Promise.all(results);
    }

    try {
        log(`开始challenge，共${allChallengePromises.length}组`);
        let i = 0;
        // eslint-disable-next-line no-restricted-syntax
        for (const challengePromises of allChallengePromises) {
            i += 1;
            log(`开始第${i}组`);
            if (opts.signal && opts.signal.aborted) {
                throw new CancelError('用户取消');
            }

            try {
                // eslint-disable-next-line no-await-in-loop
                await runPromisePa(challengePromises);
            }
            catch (e) {
                log(`证书申请失败${e.message}`);
                throw e;
            }
            finally {
                if (client.opts.sslProvider !== 'google') {
                    // letsencrypt 如果同时检出两个TXT记录，会以第一个为准，就会校验失败，所以需要提前删除
                    // zerossl 此方式测试无问题
                    log(`清理challenge痕迹，length:${clearTasks.length}`);
                    try {
                        // eslint-disable-next-line no-await-in-loop
                        await runAllPromise(clearTasks);
                    }
                    catch (e) {
                        log('清理challenge失败');
                        log(e);
                    }
                }
            }
        }
    }
    finally {
        if (client.opts.sslProvider === 'google') {
            // google 相同的域名txt记录是一样的，不能提前删除，否则校验失败，报错如下
            //  Error: The TXT record retrieved from _acme-challenge.bbc.handsfree.work.
            //  at the time the challenge was validated did not contain JshHVu7dt_DT6uYILWhokHefFVad2Q6Mw1L-fNZFcq8
            //  (the base64url-encoded SHA-256 digest of RlJZNBR0LWnxNK_xd2zqtYVvCiNJOKJ3J1NmCjU_9BjaUJgL3k-qSpIhQ-uF4FBS.NRyqT8fRiq6THzzrvkgzgR5Xai2LsA2SyGLAq_wT3qc).
            //  See https://tools.ietf.org/html/rfc8555#section-8.4 for more information.
            log(`清理challenge痕迹，length:${clearTasks.length}`);
            try {
            // eslint-disable-next-line no-await-in-loop
                await runAllPromise(clearTasks);
            }
            catch (e) {
                log('清理challenge失败');
                log(e);
            }
        }
    }

    log('challenge结束');

    // log('[auto] Waiting for challenge valid status');
    // await Promise.all(challengePromises);
    /**
     * Finalize order and download certificate
     */

    log('[auto] Finalizing order and downloading certificate');
    const finalized = await client.finalizeOrder(order, opts.csr);
    const res = await client.getCertificate(finalized, opts.preferredChain);
    return res;
    // try {
    //     await Promise.allSettled(challengePromises);
    // }
    // finally {
    //     log('清理challenge');
    //     await Promise.allSettled(clearTasks);
    // }
};
