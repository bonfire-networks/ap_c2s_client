Messaging Layer Security in ActivityPub // All config options at https://respec.org/docs/ var respecConfig = {
specStatus: "CG-DRAFT", editors: \[{ name: "Evan Prodromou", url: "https://socialwebfoundation.org/@evanp" }\], github:
"swicg/activitypub-e2ee", shortName: "apmls", xref: \["web-platform", "activitystreams-vocabulary",
"activitystreams-core", "activitypub"\], group: "socialcg", }; table td, table td \* { vertical-align: top; }

Abstract
--------

This specification documents the use of Messaging Layer Security (MLS) in the ActivityPub API and protocol. MLS is a
protocol for end-to-end encryption of 1-1 and group communications. ActivityPub is a federated social networking
protocol. This specification describes how to use ActivityPub clients to exchange MLS-encrypted messages.

Introduction
------------

Messaging Layer Security (MLS) \[\[rfc9420\]\] is an end-to-end encrypted messaging protocol. It is designed to work
with different implementations in terms of "how protected messages are delivered, contents of protected messages, and
identity/authentication infrastructures." \[\[rfc9750\]\]

\[\[ActivityPub\]\] is the W3C social networking standard. It defines an API for client to server interactions and a
federation protocol for server to server communications. ActivityPub's native data format is Activity Streams 2.0 (AS2)
\[\[activitystreams-core\]\], an extensible \[\[JSON-LD\]\] vocabulary for common social network objects and activities.

This document describes how ActivityPub can provide the Delivery Service, Authentication Service and extends the AS2
Activity Vocabulary for supporting the features specified in the MLS protocol. In short, ActivityPub servers need only
extend support for federated key delivery. All other specified functions are implemented by ActivityPub clients:

* Generating KeyPackages
* Encrypting and decrypting messages
* Constructing ActivityPub messages containing ciphertext to members of a group (see data structure below)
* Modifying cryptographic state of the group chat
* Verifying the modifications of others.

### Overview of the data structure

The data structure of an ActivityPub message that is end-to-end with MLS would be constructed by the client in the
following way from creating the message, to enciphering, to sending:

1. The encrypted message payload itself then follows ActivityPub post formats with AS2 that can then be rendered by the
client.
2. MLS as an encryption and signature layer for each message. The MLS message objects are embedded as base64-encoded
binary objects within the ActivityPub JSON envelopes.
3. ActivityPub as an envelope data structure, to ensure data routing, persistence, and federation across servers. The
JSON envelopes are conveyed directly across the ActivityPub network.

The data structure of ActivityPub posts that support the group management layer of MLS (ActivityPub servers do not
manage these objects, and are in fact unaware of their contents or interrelationships -- which is the point of
end-to-end encryption, after all):

1. A limited profile of Activity Streams 2.0 for representing messages and conversations (see application data). The
embedded AS2 content objects are intentionally not compliant with ActivityPub rules for objects -- in particular,
because object IDs in this profile are not HTTPS URLs, nor even dereferenceable URIs. These AS2 objects are embedded in
the `application_data` fields of MLS PrivateMessage objects.
2. MLS requires specific posts to be sent that are not messages but that carry information that the client needs in
order to maintain cryptographic state of the group such as the formation of a group, adding and removing members of a
group, and changes to the shared encryption keys for the group. These changes may or may not appear as system messsages
to the users in the group chat. Crucially these messages are not encrypted.
3. ActivityPub as an envelope data structure, to ensure data routing, persistence, and federation across servers. The
JSON envelopes are conveyed directly across the ActivityPub network.

This document provides an overview of the interaction between MLS and ActivityPub and specifies requisite server
extensions. However, this is not an implementation manual for MLS in ActivityPub clients. Instead, client implementers
should be familiar with both MLS and ActivityPub before attempting an implementation of end-to-end encrypted messages
between their users.

Delivery Service
----------------

The Delivery Service role in MLS has two main responsibilities:

* delivery of messages to the group ("Group channel")
* maintaining a key store ("directory")

### Message delivery

ActivityPub provides a robust delivery mechanism for AS2 objects. To send an object to others on the network, a user
POSTs a `Create` activity to their own `outbox` property with the addresses of the recipients in the `to` or `cc`
properties. The sending actor's server adds an `id` property to the activity and the object and stores the object before
forwarding it to the recipients across the federation protocol.

{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Create",
"id": "https://social.example/user/example1/create/1",
"actor": "https://social.example/user/example1",
"to": \["https://other.example/user/example2","https://third.example/user/example3"\],
"object": {
"type": "Object",
"summary": "An example object",
"id": "https://social.example/user/example1/object/1",
"attributedTo": "https://social.example/user/example1",
"to": \["https://other.example/user/example2","https://third.example/user/example3"\],
}
}


MLS data is structured in a binary format and includes detailed encryption and signature fields. For this reason, the
MLS wire formats are preserved in AS2 objects with `mediaType` set to `message/mls`.

Each of the [five MLS wire format](https://www.rfc-editor.org/rfc/rfc9420.html#name-mls-wire-formats) structures has an
equivalent data type defined as an AS2 extension in the MLS context: PublicMessage, PrivateMessage, Welcome, GroupInfo,
and KeyPackage.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"type": "Create",
"id": "https://social.example/user/example1/create/2",
"actor": "https://social.example/user/example1",
"to": \["https://other.example/user/example2","https://third.example/user/example3"\],
"object": {
"type": \["Object", "PrivateMessage"\],
"id": "https://social.example/user/example1/privatemessage/1",
"attributedTo": "https://social.example/user/example1",
"to": \["https://other.example/user/example2","https://third.example/user/example3"\],
"summary": "This is an encrypted private message. See https://swicg.github.io/activitypub-e2ee/ for information about
how to read messages like these.",
"mediaType": "message/mls",
"encoding": "base64",
"content": "\[base64-encoded private message object\]"
}
}


Because managing group membership is an essential part of the MLS protocol, delivery of MLS objects over the ActivityPub
network requires addressing all recipients explicitly. Only actors can be recipients. Clients must not address MLS
messages to collections, such as to the actor's `followers` collection or to the `as:Public` collection. See [Privacy
considerations](#privacy-considerations) for more details.

Reading incoming messages is done through the actor's [inbox](https://www.w3.org/TR/activitypub/#inbox) property. This
is a collection of all activities received by the actor,including but not exclusive to activities related to MLS.
ActivityPub does not support push notifications, so MLS-enabled ActivityPub clients have to periodically poll the inbox
collection for new activities.

Other activities in the object lifecycle, such as reactions, updates, or deletions, should be handled as part of the
application data within MLS private messages, and not as regular ActivityPub activities. So, for example, creating and
updating an encrypted `Note` is modeled as two [Create](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-create)
activities -- one for the creation, the second for the update.

### Key storage

Each actor in the ActivityPub network has a public profile with important protocol properties defined, such as
[inbox](https://www.w3.org/tr/activitypub/#inbox), [following](https://www.w3.org/TR/activitypub/#following), and
[preferredUsername](https://www.w3.org/TR/activitypub/#actor-objects).

The set of currently valid KeyPackage objects for an actor are an additional property of the actor object, keyPackages.
Its value is an ActivityPub [Collection](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-collection) of KeyPackage
objects.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"type": "Person",
"id": "https://social.example/user/example1",
"name": "Example User",
"preferredUsername": "example1",
"inbox": "https://social.example/user/example1/inbox",
"outbox": "https://social.example/user/example1/outbox",
"keyPackages": {
"type": "Collection",
"id": "https://social.example/user/example1/keyPackages",
"totalItems": 2,
"items": \[
"https://social.example/user/example1/keyPackage/A",
"https://social.example/user/example1/keyPackage/B"
\]
}
}


A KeyPackage object for an actor goes through 4 steps in its lifecycle:

1. [Create](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-create) to create the object
2. [Add](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-add) to add it to the collection of valid key packages
3. [Remove](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-remove) to remove it from the collection
4. [Delete](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-delete) to delete it and make it unavailable

Create and Add must occur in that sequence; it's not possible to add a KeyPackage before creating it. Removal and
Deletion are less strictly ordered; a key package can be removed first and deleted later, or vice versa.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"type": "Create",
"id": "https://social.example/user/example1/create/3",
"actor": "https://social.example/user/example1",
"to": "as:Public",
"object": {
"type": \["Object", "KeyPackage"\],
"id": "https://social.example/user/example1/keyPackage/C",
"attributedTo": "https://social.example/user/example1",
"to": "as:Public",
"summary": "This is binary-encoded cryptographic key package. See https://swicg.github.io/activitypub-e2ee/ for
information about how to read messages like these.",
"mediaType": "message/mls",
"encoding": "base64,
"content": "\[base64-encoded private message object\]",
"generator": {
"id": "https://client.example/actor",
"type": "Application",
"name": "Example MLS over ActivityPub client"
}
}
}


The `generator` property can be used to identify the client application associated with the `KeyPackage`.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"type": "Add",
"id": "https://social.example/user/example1/add/1",
"actor": "https://social.example/user/example1",
"to": "as:Public",
"object": "https://social.example/user/example1/keyPackage/C",
"target": "https://social.example/user/example1/keyPackages"
}


{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"type": "Remove",
"id": "https://social.example/user/example1/remove/1",
"actor": "https://social.example/user/example1",
"to": "as:Public",
"object": "https://social.example/user/example1/keyPackage/C",
"target": "https://social.example/user/example1/keyPackages"
}


{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"type": "Delete",
"id": "https://social.example/user/example1/delete/1",
"actor": "https://social.example/user/example1",
"to": "as:Public",
"object": "https://social.example/user/example1/keyPackage/C"
}


As with all ActivityPub objects, the KeyPackage can be read in full using an HTTP GET request to the
[id](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-id) URL.

Authentication Service
----------------------

The Authentication Service in the MLS framework has the responsibility of confirming the relationship between a
`KeyPackage` object and an identity. In ActivityPub, an identity is expressed as an actor object URL.

In the ActivityPub model shown here, authenticating a `KeyPackage` requires three steps:

1. Retrieving the actor with the given ID; this requires an HTTP GET request to the actor ID URL.
2. Verifying that the actor object has a `keyPackages` property.
3. Confirming that the given `KeyPackage` object is an item in the `keyPackages` collection.

Application data
----------------

MLS is agnostic about application data encrypted and sent over the network. To match the ActivityPub model, this
specification defines the application data for use over MLS as Activity Streams 2.0 content objects and activities.
Unlike ActivityPub objects, these AS2 objects are not available for download from any server, and do not use HTTPS URLs
as `id` values.

In general, the content of the MLS messages should be self-encapsulated and not dependent on external resources. Client
applications cannot rely on a server to save state for the group and the shared application data. This restricts the use
of URLs and `Link` objects in the content.

### Content objects

The Activity Vocabulary defines several document types for content. The following types are used in this specification.

* [Note](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-note) - for short text, about a paragraph or less, like a
microblogging post or a comment
* [Article](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-article) - for longer texts, about the length of a
magazine article or a blog post
* [Image](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-image) - two-dimensional images, like photos or diagrams
* [Audio](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-audio) - any sound files, like music, a sound effect, or
a podcast episode
* [Video](https://www.w3.org/TR/activitystreams-vocabulary/#dfn-video) - moving images, like a movie, TV show, or short

There are the following restrictions on the properties of the content objects:

* `id`. This should be a unique URI, but not an HTTPS URL. A UUID, for example, provides a reasonably unique value that
can be indexed in the client's local storage.
* `mediaType`. For `Note` and `Article`, these should be unset, or use the default "text/html". For the other content
types, this should include the Internet Media Type for the object, such as "image/png" or "video/ogg".
* `encoding`. A new property introduced in this document; the default value is "base64", for base64 encoding.
* `content`. For `Note` and `Article`, this should be the HTML content of the object, as usual. For the other types,
this should be the base64-encoded content of the object itself. For an `Image` in Portable Network Graphics (PNG)
format, the `content` property value will be the base64-encoded image data.
* `summary`. A summary or description of the content.
* `url`. This should be undefined; the object should not have a version available as a Web page.
* `attachment`. These values should not be `Link` objects; instead, they should be content objects of the above types.
They should be included fully using base64-encoded values in the `content` property, with the `mediaType` property set.
* `inReplyTo`. Should be the `id` of a content object already delivered to the same group.
* `replies`, `likes`, and `shares`. In this application of MLS, reactions to content objects are not tracked by a
server, but by each client individually. Consequently, these values should be unset.
* `attributedTo`. This can be derived from the properties of the ActivityPub envelope and are not required. If provided,
it should be ignored.
* `to`, `cc`, and other addressing properties. These can be derived from the properties of the ActivityPub envelope and
are not required.
* `tag`. `Mention` and `Hashtag` object ids can be used to identify topics or mentioned actors.

#### Examples

{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Note",
"id": "uri:uuid:CFCD9E78-03E4-404E-A7A8-3E17A78EC4E1",
"content": "
Hello, World!"
}


{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Note",
"id": "uri:uuid:C52C4A75-0EE2-4E2B-BDFA-3BEAC534A24D",
"inReplyTo": "uri:uuid:CFCD9E78-03E4-404E-A7A8-3E17A78EC4E1",
"content": "
Hello back!"
}


For reasons of brevity, this example is not a long, multiparagraph text.

{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Article",
"id": "uri:uuid:3298C3D5-E55E-4FAA-B365-5C81034CAF10",
"name": "A simple countdown",
"summary": "
This article counts down from five to one.",
"content": "
Five!
Four!
Three!
Two!
One!"
}


{
"@context": "https://www.w3.org/ns/activitystreams",
"id": "uri:uuid:38B03587-CEA8-439B-AFCE-6CC3C69E51FD",
"type": "Image",
"name": "One-pixel PNG",
"mediaType": "image/png",
"content":
"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII="
}


### Activities

Activities are the top-level content in MLS messages.

The following Activity types from the Activity Vocabulary are defined in this document.

* `Create` Introduces a new object. The value of the `object` property should be a [node
object](https://www.w3.org/TR/json-ld11/#node-objects) -- all properties represented as a JSON object. The `id` of the
object must be unique.
* `Update` Updates the properties of an existing object.Only changed properties must be included in the `object`
property. The `id` property must match an object that was received as the `object` of a `Create` property previously.
Only the sender of the `Create` activity can send an `Update` for the same object.
* `Delete` Deletes an existing object. The `object` property can be a node object or a reference. The `id` property must
match an object that was received as the `object` of a `Create` property previously. Only the sender of the `Create`
activity can send an `Delete` for the same object.
* `Like` Indicates that the sender likes the `object`. The `object` property can be a node object or a reference. The
`id` property must match an object that was received as the `object` of a `Create` property previously.
* `Announce` Shares the `object` with the group. The `object` property can be a node object or a reference. The `id`
property can match an object that was received as the `object` of a `Create` property previously; alternately, it can be
an ActivityPub object with an HTTPS URL `id`. The latter case allows sharing public content into a private chat for
discussion, possibly with a comment.
* `Undo` Undoes the activity that is the `object`. The `object` property can be a node object or a reference. The `id`
property must match an activity that was received previously. Only the sender of the previous activity can undo it.
Undoing a `Like` activity shows that the sender does not like the object. The results of undoing other activity types
are undefined.
* `Read`. Indicates that the sender has read a `Note` or `Article`, or the description of an `Image` or other binary
file type. The `object` property should be a partial embedding or a reference. The `id` property must match an object
that was received as the `object` of a `Create` property previously. (`Read` is an activity type from the Activity
Vocabulary that is not described in detail in the ActivityPub specification.)
* `Listen`. Indicates that the sender has listened to an `Audio` object. The `object` property should be a partial
embedding or a reference. The `id` property must match an object that was received as the `object` of a `Create`
property previously. (`Listen` is an activity type from the Activity Vocabulary that is not described in detail in the
ActivityPub specification.)
* `View`. Indicates that the sender has viewed an `Image` object or `Video` object. The `object` property should be a
partial embedding or a reference. The `id` property must match an object that was received as the `object` of a `Create`
property previously. (`View` is an activity type from the Activity Vocabulary that is not described in detail in the
ActivityPub specification.)
* `IntransitiveActivity`. This is a base activity type defined in the Activity Vocabulary. For this specification, an
`IntransitiveActivity` object can be sent as a null message, which can obscure messaging patterns (see [Metadata
leakage](#metadata-leakage)). Recipients should ignore and discard the activity. (`IntransitiveActivity` is an activity
type from the Activity Vocabulary that is not described in detail in the ActivityPub specification.)

#### Examples

{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Create",
"id": "uri:uuid:C63C6A5C-68EE-4327-86CE-C1B1328B5F2F",
"object": {
"type": "Note",
"id": "uri:uuid:CFCD9E78-03E4-404E-A7A8-3E17A78EC4E1",
"content": "
Hello, World!"
}
}


{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Update",
"id": "uri:uuid:FDD0D007-B229-4050-B770-EEA8C89A69D6",
"object": {
"type": "Note",
"id": "uri:uuid:CFCD9E78-03E4-404E-A7A8-3E17A78EC4E1",
"content": "
Hello, World Universe!"
}
}


{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Delete",
"id": "uri:uuid:BDF97A60-7C46-465C-A98D-6134BEC1FEF3",
"object": "uri:uuid:CFCD9E78-03E4-404E-A7A8-3E17A78EC4E1"
}


{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Like",
"id": "uri:uuid:0DDF82B4-8632-4E20-85E1-547155C2618E",
"object": {
"type": "Article",
"id": "uri:uuid:3298C3D5-E55E-4FAA-B365-5C81034CAF10"
}
}


{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Announce",
"id": "uri:uuid:34959BBB-511B-44DF-B925-F2FF5AA671D6",
"content": "Here's Jake's earlier message you might have missed, Janice",
"object": {
"type": "Note",
"id": "uri:uuid:C52C4A75-0EE2-4E2B-BDFA-3BEAC534A24D"
}
}


{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Undo",
"id": "uri:uuid:C5F83D10-0F05-406D-AEAA-970F96815A9B",
"object": {
"type": "Like",
"id": "uri:uuid:0DDF82B4-8632-4E20-85E1-547155C2618E"
}
}


{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "Read",
"id": "uri:uuid:5865EF99-2675-4EFB-8D7E-1F1B62470676",
"object": {
"type": "Article",
"id": "uri:uuid:3298C3D5-E55E-4FAA-B365-5C81034CAF10"
}
}


{
"@context": "https://www.w3.org/ns/activitystreams",
"type": "IntransitiveActivity",
"id": "uri:uuid:AD1D2303-8CA8-416A-BDF7-E8A9FC368C54"
}


### Extensions

Other activity or content types from the Activity Vocabulary, and from Activity Streams 2.0 extensions, may be used in
this structure. The use of extended properties or types in the encrypted content of MLS over ActivityPub should be
documented on the W3C wiki.

Context
-------

The terms in this document are defined in a context document that can be used in \[\[JSON-LD\]\] documents. The context
document is available at [https://purl.archive.org/socialweb/mls](https://purl.archive.org/socialweb/mls).

To use these terms, documents should include this context URL in the `@context` property of the JSON-LD document.

Example usage of the context.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"id": "https://example.com/users/evan",
"type": "Person",
"name": "Evan Prodromou",
"keyPackages": \[
"https://example.com/keys/evan/client1",
"https://example.com/keys/evan/client2"
\]
}


The context document defines a namespace prefix `mls` defined as `https://purl.archive.org/socialweb/mls#`.

### Version-stamped URLs

To ease the use of this context for implementers with strict versioning requirements, additional URL aliases are
provided with versions included. A [semantic versioning](https://semver.org/) strategy is used to convey the guarantees
of the version number.

Version

URL

Notes

(latest)

[https://purl.archive.org/socialweb/mls](https://purl.archive.org/socialweb/mls)

The latest version of the context is always available at this URL. Most implementers can use this URL.

1.0.0

[https://purl.archive.org/socialweb/mls/1.0.0](https://purl.archive.org/socialweb/mls/1.0.0)

The exact version of the context document. The resource at this URL should be immutable. This URL is useful for
implementers that need an exact, byte-wise replicable version of the document.

1.0.x

[https://purl.archive.org/socialweb/mls/1.0](https://purl.archive.org/socialweb/mls/1.0)

Backwards-compatible fixes are possible, but no additional types or properties are defined. This is useful for
implementers that use multiple extensions and want to ensure that no conflicting terms are added.

1.x.x

[https://purl.archive.org/socialweb/mls/1](https://purl.archive.org/socialweb/mls/1)

Backwards-compatible fixes, additional types and properties are possible. This is useful for implementers that want to
ensure that the properties and types they use are stable and will not change, but do not need to avoid term conflicts.

Using the version-stamped context URLs is similar to the unstamped URL.

Example usage of a version-stamped context URL.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls/1.0"
\],
"id": "https://example.com/users/evan",
"type": "Person",
"name": "Evan Prodromou",
"keyPackages": \[
"https://example.com/keys/evan/client1",
"https://example.com/keys/evan/client2"
\]
}


If backwards-incompatible changes to this context are made in the future, a new major version (2.x.x) would be added and
the existing 1.x.x URLs would continue to be provided.

Terms
-----

These terms are defined in the MLS namespace for ActivityPub. There are five new object types, and one new property.

### Types

There are five types defined in this context.

### PublicMessage

URI:

`https://purl.archive.org/socialweb/mls#PublicMessage`
`mls:PublicMessage`
`PublicMessage`

Notes:

The PublicMessage data type from MLS. The `mediaType` should be "message/mls", and the `content` should be
base64-encoded binary data matching an [MLSMessage](https://www.rfc-editor.org/rfc/rfc9420.html#name-message-framing)
structure with a [PublicMessage](https://www.rfc-editor.org/rfc/rfc9420.html#name-encoding-and-decoding-a-pub) wire
type.

Extends:

`Object`

Properties:

Inherited from `Object`

A PublicMessage object.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"id": "https://example.com/users/alyssa/publicmessage/1",
"type": "PublicMessage",
"attributedTo": "https://example.com/users/alyssa",
"to": \[
"https://social.example/users/example1",
"https://another.example/users/example2"
\],
"mediaType": "message/mls",
"encoding": "base64",
"summary": "This is a public message in MLS format.",
"content": "\[base64-encoded MLSMessage\]",
"generator": {
"id": "https://client.example/actor",
"type": "Application",
"name": "MLS-enabled ActivityPub client"
}
}


### PrivateMessage

URI:

`https://purl.archive.org/socialweb/mls#PrivateMessage`
`mls:PrivateMessage`
`PrivateMessage`

Notes:

The PrivateMessage data type from MLS. The `mediaType` should be "message/mls", and the `content` should be
base64-encoded binary data matching an [MLSMessage](https://www.rfc-editor.org/rfc/rfc9420.html#name-message-framing)
structure with a [PrivateMessage](https://www.rfc-editor.org/rfc/rfc9420.html#name-encoding-and-decoding-a-pri) wire
type.

Extends:

`Object`

Properties:

Inherited from `Object`

A PrivateMessage object.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"id": "https://example.com/users/alyssa/privatemessage/1",
"type": "PrivateMessage",
"attributedTo": "https://example.com/users/alyssa",
"to": \[
"https://social.example/users/example1",
"https://another.example/users/example2"
\],
"mediaType": "message/mls",
"encoding": "base64",
"summary": "This is a private message in MLS format.",
"content": "\[base64-encoded MLSMessage\]",
"generator": {
"id": "https://client.example/actor",
"type": "Application",
"name": "MLS-enabled ActivityPub client"
}
}


### KeyPackage

URI:

`https://purl.archive.org/socialweb/mls#KeyPackage`
`mls:KeyPackage`
`KeyPackage`

Notes:

The KeyPackage data type from MLS. The `mediaType` should be "message/mls", and the `content` should be base64-encoded
binary data matching an [MLSMessage](https://www.rfc-editor.org/rfc/rfc9420.html#name-message-framing) structure with a
[KeyPackage](https://www.rfc-editor.org/rfc/rfc9420.html#name-key-packages) wire type.

Extends:

`Object`

Properties:

Inherited from `Object`

A KeyPackage object.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"id": "https://example.com/users/alyssa/keypackage/1",
"type": "KeyPackage",
"attributedTo": "https://example.com/users/alyssa",
"to": "as:Public",
"mediaType": "message/mls",
"encoding": "base64",
"summary": "This is a key package in MLS format.",
"content": "\[base64-encoded MLSMessage\]",
"generator": {
"id": "https://client.example/actor",
"type": "Application",
"name": "MLS-enabled ActivityPub client"
}
}


### GroupInfo

URI:

`https://purl.archive.org/socialweb/mls#GroupInfo`
`mls:GroupInfo`
`GroupInfo`

Notes:

The GroupInfo data type from MLS. The `mediaType` should be "message/mls", and the `content` should be base64-encoded
binary data matching an [MLSMessage](https://www.rfc-editor.org/rfc/rfc9420.html#name-message-framing) structure with a
[GroupInfo](https://www.rfc-editor.org/rfc/rfc9420.html#section-12.4.3) wire type.

Extends:

`Object`

Properties:

Inherited from `Object`

A GroupInfo object.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"id": "https://example.com/users/alyssa/groupinfo/1",
"type": "GroupInfo",
"attributedTo": "https://example.com/users/alyssa",
"to": "https://social.example/user/example1",
"mediaType": "message/mls",
"encoding": "base64",
"summary": "This is a group information packet in MLS format.",
"content": "\[base64-encoded MLSMessage\]",
"generator": {
"id": "https://client.example/actor",
"type": "Application",
"name": "MLS-enabled ActivityPub client"
}
}


### Welcome

URI:

`https://purl.archive.org/socialweb/mls#Welcome`
`mls:Welcome`
`Welcome`

Notes:

The Welcome data type from MLS. The `mediaType` should be "message/mls", and the `content` should be base64-encoded
binary data matching an [MLSMessage](https://www.rfc-editor.org/rfc/rfc9420.html#name-message-framing) structure with a
[Welcome](https://www.rfc-editor.org/rfc/rfc9420.html#section-12.4.3.1) wire type.

Extends:

`Object`

Properties:

Inherited from `Object`

A Welcome object.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"id": "https://example.com/users/alyssa/welcome/1",
"type": "Welcome",
"attributedTo": "https://example.com/users/alyssa",
"to": "https://social.example/user/example1",
"mediaType": "message/mls",
"encoding": "base64",
"summary": "This is a welcome packet in MLS format.",
"content": "\[base64-encoded MLSMessage\]",
"generator": {
"id": "https://client.example/actor",
"type": "Application",
"name": "MLS-enabled ActivityPub client"
}
}


### Properties

There are two properties defined in the namespace.

### encoding

URI:

`https://purl.archive.org/socialweb/mls#encoding`
`mls:encoding`
`encoding`

Notes:

The `encoding` property represents the encoding for the `content` property, similar to the
[Content-Transfer-Encoding](https://www.ietf.org/rfc/rfc2045.html#section-6) header in email and HTTP messages.

Domain:

`Object`

Range:

String; values for [Content-Transfer-Encoding](https://www.ietf.org/rfc/rfc2045.html#section-6) in \[\[rfc2045\]\]

Functional:

`true`

An Image object with an encoding property.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"id": "https://example.com/image/1",
"type": "Image",
"name": "One-pixel PNG",
"mediaType": "image/png",
"encoding": "base64",
"content":
"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII="
}


### keyPackages

URI:

`https://purl.archive.org/socialweb/mls#keyPackages`
`mls:keyPackages`
`keyPackages`

Notes:

The `keyPackages` property represents the client keys for an actor. As with other JSON-LD `@id` properties, its value
can be a string for the URL of the key, a JSON object with the properties of the key itself, or an array of strings
and/or objects.

Domain:

`Object` (an ActivityPub [Actor](https://www.w3.org/TR/activitypub/#actors))

Range:

`Key`

Functional:

`false`

An ActivityPub actor with a `keyPackages` property.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"id": "https://example.com/users/alyssa",
"type": "Person",
"name": "Alyssa P. Hacker",
"inbox": "https://example.com/users/alyssa/inbox",
"outbox": "https://example.com/users/alyssa/outbox",
"followers": "https://example.com/users/alyssa/followers",
"following": "https://example.com/users/alyssa/following",
"liked": "https://example.com/users/alyssa/liked",
"keyPackages": "https://example.com/users/alyssa/key"
}


### messages

URI:

`https://purl.archive.org/socialweb/mls#messages`
`mls:messages`
`messages`

Notes:

The value of the `messages` property is an `OrderedCollection` of all the MLS-related activities that an actor has
received in their `inbox`. Like the `inbox`, it is sorted in reverse chronological order (latest activities first).

Without this property, the messaging client needs to scan the `inbox` for messaging-related activities.

Domain:

`Object` (an ActivityPub [Actor](https://www.w3.org/TR/activitypub/#actors))

Range:

`OrderedCollection`

Functional:

`true`

An ActivityPub actor with a `messages` property.

{
"@context": \[
"https://www.w3.org/ns/activitystreams",
"https://purl.archive.org/socialweb/mls"
\],
"id": "https://example.com/users/alyssa",
"type": "Person",
"name": "Alyssa P. Hacker",
"inbox": "https://example.com/users/alyssa/inbox",
"outbox": "https://example.com/users/alyssa/outbox",
"followers": "https://example.com/users/alyssa/followers",
"following": "https://example.com/users/alyssa/following",
"liked": "https://example.com/users/alyssa/liked",
"messages": {
"type": "OrderedCollection",
"id": "https://example.com/users/alyssa/messages",
"totalItems": 20018,
"first": "https://example.com/users/alyssa/messages/75geefBI",
"current": "https://example.com/users/alyssa/messages/75geefBI",
"last": "https://example.com/users/alyssa/messages/ZcbaTBMI"
}
}


Security considerations
-----------------------

These are notable security considerations with this specification.

### HTML Sanitization

Many of the [content types](#content-objects) included in the application data for this specification use HTML either
for the `summary` or `content` properties. Attackers can use features of HTML5, like JavaScript and CSS, to cause
problems in the users' browsers. One mitigation is to sanitize the HTML, removing elements and attributes that can be
problematic for users.

In ActivityPub, many servers will sanitize HTML for content as it arrives at the server, so that clients can use the
content without security concerns. Because the encrypted application data in this specification is not visible to the
ActivityPub server, it is up to the client application to sanitize the HTML.

### Key Substitution

The keyPackages collection used in this document for sharing and confirming cryptographic keys is easy to implement and
use. However, because the collection is managed by the actor's server, the collection is subject to a key substitution
attack. A malicious server can add one of its own keys to the collection, or replace one of the keys with its own.
Sophisticated attackers would present different `keyPackages` collection contents to different clients.

One mitigation for this attack is key-fingerprint verification, in which participants in a group compare the
fingerprints they see for keys for an identity.

### Private key storage

The private keys created by clients and used for encryption and signatures in the MLS framework are crucial to the
security of the system. Compromise of the key through physical or remote access to the device could expose encrypted
data in the server-stored messages. To mitigate this risk, client applications should make use of platform services for
secure key storage where available. If keys must be stored on disk, they should be encrypted with a password under the
user's control.

### Plaintext storage

Rebuilding group state and decrypted message content from server-stored MLS message data in the `inbox` can be
time-consuming. Therefore, many clients will persist that state and decrypted content on the client side. But physical
or remote access to the client device could expose that decrypted content to an attacker.

One mitigation for this risk is to store decrypted content locally in an encrypted file or drive volume, with the
encryption key stored in the platform's secure storage, or with a password under the user's control.

Privacy considerations
----------------------

### Metadata leakage

The binary MLS objects used in this specification have strong encryption to protect the contents from servers. The
ActivityPub envelopes used for their delivery, however, can be inspected by servers along the delivery path -- the
sending actor's server and the receiving actors' servers.

There is metadata in the envelopes that can be used by an observer to draw conclusions about the conversations.

* **Sender and recipients**. These addressing properties are necessary for the delivery of ActivityPub objects.
* **Timestamps**. Timestamps are added by the sender's server and forwarded to other servers. They can be used to
analyse patterns in the conversation. One mitigation is to add random dummy messages with the `IntransitiveActivity`
activity type (see above), which can obscure the real patterns in conversations.
* **Message size**. The size of the `PrivateMessage` objects can give a signal for what the contents of the message are.
For example, a `Like` activity which uses the object's ID URI as a property value would be smaller than a `Create`
activity with an embedded node object as the `object` property value. MLS provides
[padding](https://www.rfc-editor.org/rfc/rfc9420.html#section-15.1) feature to mitigate this problem.

Changelog
---------

* 11 Jun 2025: Revised version focused on embedding binary MLS message objects in ActivityPub wrappers. Added
application data model, security and privacy considerations; removed use cases to focus on more technical goal of
implementing MLS over ActivityPub.
* 22 Nov 2024: Early version with use cases, context, types and properties.