import EventEmitter from 'eventemitter3';
import { Promise } from 'rsvp';
import { decodeDate, keyRemap, union, difference } from './utils';
import IMClient from './im-client';
import {
  GenericCommand,
  ConvCommand,
  JsonObjectMessage,
  DirectCommand,
} from '../proto/message';
import { createError } from './errors';
import Message from './messages/message';
import isEmpty from 'lodash/isEmpty';
import isPlainObject from 'lodash/isPlainObject';
import { default as d } from 'debug';

const debug = d('LC:Conversation');

export default class Conversation extends EventEmitter {
  constructor(data, client) {
    super();
    Object.assign(this, {
      // id,
      // name,
      // creator,
      // createdAt,
      // updatedAt,
      // lastMessageAt,
      // lastMessage,
      mutedMembers: [],
      members: [],
      _attributes: {},
      transient: false,
      muted: false,
    }, keyRemap({
      attributes: '_attributes',
      name: '_name',
    }, data));
    this.members = Array.from(new Set(this.members));
    if (client instanceof IMClient) {
      this._client = client;
    } else {
      throw new TypeError('Conversation must be initialized with a client');
    }
    [
      'kicked',
      'membersjoined',
      'membersleft',
      'message',
    ].forEach(event => this.on(
      event,
      payload => this._debug(`${event} event emitted.`, payload)
    ));
  }

  set createdAt(value) {
    this._createdAt = decodeDate(value);
  }
  get createdAt() {
    return this._createdAt;
  }
  set updatedAt(value) {
    this._updatedAt = decodeDate(value);
  }
  get updatedAt() {
    return this._updatedAt;
  }
  set lastMessageAt(value) {
    this._lastMessageAt = decodeDate(value);
  }
  get lastMessageAt() {
    return this._lastMessageAt;
  }

  get attributes() {
    if (typeof this._pendingAttributes !== 'undefined') {
      return this._pendingAttributes;
    }
    return this._attributes;
  }
  set attributes(value) {
    this.setAttributes(value);
  }
  setAttributes(map, assign = false) {
    this._debug(`set attributes: value=${JSON.stringify(map)}, assign=${assign}`);
    if (!isPlainObject(map)) {
      throw new TypeError('attributes must be a plain object');
    }
    if (!assign) {
      this._pendingAttributes = map;
    } else {
      this._pendingAttributes = Object.assign({}, this.attributes, map);
    }
  }
  setAttribute(key, value) {
    if (typeof this._pendingAttributes === 'undefined') {
      this._pendingAttributes = {};
    }
    this._pendingAttributes[key] = value;
  }

  get name() {
    if (typeof this._pendingName !== 'undefined') {
      return this._pendingName;
    }
    return this._name;
  }
  set name(value) {
    this.setName(value);
  }
  setName(value) {
    this._debug(`set name: ${value}`);
    this._pendingName = value;
  }

  _debug(...params) {
    debug(...params, `[${this.id}]`);
  }

  _send(command) {
    /* eslint-disable no-param-reassign */
    if (command.cmd === null) {
      command.cmd = 'conv';
    }
    if (command.cmd === 'conv' && command.convMessage === null) {
      command.convMessage = new ConvCommand();
    }
    if (command.convMessage && command.convMessage.cid === null) {
      command.convMessage.cid = this.id;
    }
    /* eslint-enable no-param-reassign */
    return this._client._send(command);
  }

  save() {
    this._debug('save');
    const attr = {};
    if (typeof this._pendingAttributes !== 'undefined') {
      attr.attr = this._pendingAttributes;
    }
    if (typeof this._pendingNamed !== 'undefined') {
      attr.name = this._pendingName;
    }
    if (isEmpty(attr)) {
      this._debug('nothing touched, resolve with self');
      return Promise.resolve(this);
    }
    this._debug(`attr: ${JSON.stringify(attr)}`);
    const convMessage = new ConvCommand({
      attr: new JsonObjectMessage({
        data: JSON.stringify(attr),
      }),
    });
    return this
      ._send(new GenericCommand({
        op: 'update',
        convMessage,
      }))
      .then(resCommand => {
        this.updatedAt = resCommand.convMessage.udate;
        if (typeof this._pendingAttributes !== 'undefined') {
          this._attributes = this._pendingAttributes;
          delete this._pendingAttributes;
        }
        if (typeof this._pendingNamed !== 'undefined') {
          this._name = this._pendingName;
          delete this._pendingName;
        }
        return this;
      });
  }

  fetch() {
    return this
      ._client
      .getQuery()
      .equalTo('objectId', this.id)
      .find()
      .then(() => this);
  }

  mute() {
    this._debug('mute');
    return this._send(new GenericCommand({
      op: 'mute',
    })).then(() => {
      if (!this.transient) {
        this.muted = true;
        this.mutedMembers = union(this.mutedMembers, [this._client.id]);
      }
      return this;
    });
  }

  unmute() {
    this._debug('unmute');
    return this._send(new GenericCommand({
      op: 'unmute',
    })).then(() => {
      if (!this.transient) {
        this.muted = false;
        this.mutedMembers = difference(this.mutedMembers, [this._client.id]);
      }
      return this;
    });
  }

  count() {
    this._debug('unmute');
    return this._send(new GenericCommand({
      op: 'count',
    })).then(resCommand => resCommand.convMessage.count);
  }

  add(clientIds) {
    this._debug('add', clientIds);
    if (typeof clientIds === 'string') {
      clientIds = [clientIds]; // eslint-disable-line no-param-reassign
    }
    const convMessage = new ConvCommand({
      m: clientIds,
    });
    return this._send(new GenericCommand({
      op: 'add',
      convMessage,
    })).then(() => {
      if (!this.transient) {
        this.members = union(this.members, clientIds);
      }
      return this;
    });
  }
  remove(clientIds) {
    this._debug('remove', clientIds);
    if (typeof clientIds === 'string') {
      clientIds = [clientIds]; // eslint-disable-line no-param-reassign
    }
    const convMessage = new ConvCommand({
      m: clientIds,
    });
    return this._send(new GenericCommand({
      op: 'remove',
      convMessage,
    })).then(() => {
      if (!this.transient) {
        this.members = difference(this.members, clientIds);
      }
      return this;
    });
  }

  send(message) {
    debug(message, 'send');
    if (!(message instanceof Message)) {
      throw new TypeError(`${message} is not a Message`);
    }
    message._setProps({
      cid: this.id,
      from: this._client.id,
    });
    let msg = message.toJSON();
    if (typeof msg !== 'string') {
      msg = JSON.stringify(msg);
    }
    return this._send(new GenericCommand({
      cmd: 'direct',
      directMessage: new DirectCommand({
        msg,
        cid: this.id,
        r: message.needReceipt,
        transient: message.transient,
        dt: message.id,
      }),
    })).then(resCommand => {
      const {
        ackMessage: {
          uid,
          t,
          code,
          reason,
          appCode,
        },
      } = resCommand;
      if (code !== null) {
        throw createError({
          code, reason, appCode,
        });
      }
      message._setProps({
        id: uid,
        timestamp: new Date(t.toNumber()),
      });
      this.lastMessage = message;
      this.lastMessageAt = message.timestamp;
      return message;
    });
  }
}
