import { afterAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb, createGroupRepos, createRepos, createThreadMessage, requireMembership, IsolationError } from '@rakazo/db';
import { mountGroupSharing } from './group-sharing.js';
import { resolveThreadTarget, sendThreadMessage } from './thread-target.js';

const enabled = process.env.VERIFY_GROUP_SHARING === 'true';
(enabled ? describe : describe.skip)('explicit group sharing on isolated PostgreSQL', () => {
  let db: ReturnType<typeof createDb>;
  afterAll(async () => { if (db) { await db.prisma.$disconnect(); await db.pool.end(); } });
  it('isolates private bots, attributes collaborative sends, deduplicates and revokes access', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    expect(url.pathname).toBe('/rakazo_sharing_test'); // Never write fixtures to the live database.
    db = createDb(url.href);
    const p = db.prisma, suffix = Date.now();
    const ownerId = `owner-${suffix}`, colleagueId = `colleague-${suffix}`, otherId = `other-${suffix}`;
    for (const id of [ownerId,colleagueId,otherId]) await p.user.create({ data: { id, name: id, email: `${id}@example.invalid`, emailVerified: true } });
    const org = await p.organization.create({ data: { id: `org-${suffix}`, name: 'Test', slug: `org-${suffix}`, createdAt: new Date() } });
    const space = await p.space.create({ data: { id: `space-${suffix}`, organizationId: org.id, name: 'Shared fixture', isDefault: true, createdByUserId: ownerId } });
    for (const id of [ownerId,colleagueId,otherId]) {
      await p.member.create({ data: { id: `member-${id}`, organizationId: org.id, userId: id, role: id === ownerId ? 'owner' : 'member', createdAt: new Date() } });
    }
    const owner = await requireMembership(p,ownerId,space.id), colleague = await requireMembership(p,colleagueId,space.id);
    const botIds = [];
    for (const name of ['Alpha','Beta']) {
      const bot = await p.bot.create({ data: { spaceId: space.id, userId: ownerId, name, color: '#00aa88' } }); botIds.push(bot.id);
      await p.thread.create({ data: { spaceId: space.id, userId: ownerId, botId: bot.id } });
    }
    const group = await createGroupRepos(p).createGroup(owner,{ name:'Team', botIds });
    const privateMessage = await createThreadMessage(p,{ threadId: (await createRepos(p).getBot(owner,botIds[0]!)).thread!.id, role:'user', blocks:[{ kind:'text', text:'PRIVATE_BOT_HISTORY' }] });
    const app = new Hono();
    const deps = { prisma:p, auth:{ api:{ getSession: async ({headers}: {headers:Headers}) => { const id=headers.get('x-test-user'); return id ? { user:{id} } : null; } } }, sessionHeaders:(req:Request)=>req.headers, events:{ notify:vi.fn(async()=>{}) }, jobs:{ enqueue:vi.fn(async()=>{}) } };
    mountGroupSharing(app,deps as any);
    const path=`/api/group-sharing/groups/${group.id}`;
    async function call(userId:string|null, route:string, body?:object) {
      const res=await app.request(route,{method:body?'POST':'GET',headers:{...(userId?{'x-test-user':userId}:{}),'content-type':'application/json','x-rakazo-space-id':space.id},...(body?{body:JSON.stringify(body)}:{})});
      return {status:res.status,data:await res.json()};
    }
    expect((await call(null,path+'/messages')).status).toBe(401);
    expect((await call(colleagueId,path+'/messages')).status).toBe(404);
    expect((await call(otherId,'/api/group-sharing/groups')).data.groups).toEqual([]);
    expect((await call(ownerId,path+'/people',{userId:colleagueId,shared:true})).status).toBe(200);
    expect((await call(ownerId,path+'/people',{userId:colleagueId,shared:true})).status).toBe(200);
    expect((await call(colleagueId,path+'/people',{userId:otherId,shared:true})).status).toBe(404);
    expect((await call(otherId,path+'/messages')).status).toBe(404);
    expect((await call(colleagueId,'/api/group-sharing/groups')).data.groups[0].id).toBe(group.id);
    const body={text:'Hello team',clientNonce:'first_nonce_123'};
    expect((await call(colleagueId,path+'/messages',body)).status).toBe(200);
    expect((await call(colleagueId,path+'/messages',body)).status).toBe(200);
    expect(await p.message.count({where:{threadId:group.threadId,role:'user'}})).toBe(1);
    expect(await p.run.count({where:{threadId:group.threadId,userId:ownerId}})).toBe(1);
    expect(await p.run.count({where:{threadId:group.threadId,userId:colleagueId}})).toBe(0);
    await createThreadMessage(p,{threadId:group.threadId,role:'bot',botId:botIds[0],blocks:[{kind:'text',text:'Team reply'}]});
    const ownerMessages=(await call(ownerId,path+'/messages')).data.messages;
    const sharedMessages=(await call(colleagueId,path+'/messages')).data.messages;
    expect(sharedMessages).toEqual(ownerMessages);
    expect(sharedMessages[0].author).toBe(colleagueId);
    expect(sharedMessages[0].text).toContain('Hello team');
    expect(sharedMessages[1].text).toBe('Team reply');
    expect((await call(colleagueId,path+'/messages?before=1')).data.messages).toHaveLength(1);
    expect((await call(colleagueId,path+'/messages?before=0')).data.messages).toHaveLength(0);
    expect(JSON.stringify(sharedMessages)).not.toContain('PRIVATE_BOT_HISTORY');
    await expect(createRepos(p).getBot(colleague,botIds[0]!)).rejects.toBeInstanceOf(IsolationError);
    const staleTarget=await resolveThreadTarget(p,owner,{groupId:group.id});
    if(staleTarget.kind==='group') staleTarget.sharedRequester=colleague;
    expect((await call(ownerId,path+'/people',{userId:colleagueId,shared:false})).status).toBe(200);
    expect((await call(colleagueId,path+'/messages')).status).toBe(404);
    expect((await call(colleagueId,path+'/messages',body)).status).toBe(404);
    await expect(sendThreadMessage(deps as any,owner,staleTarget,{text:'Stale request',clientNonce:'stale_nonce_123'})).rejects.toBeInstanceOf(IsolationError);
    expect((await call(ownerId,path+'/people',{userId:colleagueId,shared:true})).status).toBe(200);
    await p.spaceMember.delete({where:{spaceId_userId:{spaceId:space.id,userId:colleagueId}}});
    expect((await call(colleagueId,path+'/messages')).status).toBe(404);
    await p.chatGroup.update({where:{id:group.id},data:{archivedAt:new Date()}});
    expect((await call(ownerId,path+'/messages')).status).toBe(404);
    await p.organization.delete({where:{id:org.id}});
    await p.user.deleteMany({where:{id:{in:[ownerId,colleagueId,otherId]}}});
  });
});
